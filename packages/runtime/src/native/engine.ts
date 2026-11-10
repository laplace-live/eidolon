// Which voice engine answers a call: pipedog's pipeline, or the native loop in @eidolon/voice.
// EIDOLON_VOICE_ENGINE picks one at boot; under native, an offer whose call can't run natively yet
// still goes to pipedog. docs/voice-engine.md.
import type { AllowedOffer } from "@eidolon/access";
import { CHAT_FORMAT, type ChatHeader, summarize } from "@eidolon/chat";
import { activePersona, envStr, errorText, logger, pyRepr, withPersona } from "@eidolon/config";
import { type ProviderId, select, selectRequired } from "@eidolon/providers";
import {
  type CallDeps,
  type CallLog,
  type CallTransport,
  type CloseReason,
  memoryCallLog,
  runVoiceCall,
} from "@eidolon/voice";
import { logSessionStart } from "../session/start.ts";
import {
  type AnyCallBinding,
  type BoundCall,
  bindCall,
  bindGroupCall,
  isGroupCall,
  reportEnd,
} from "./binding.ts";

export type VoiceEngine = "pipedog" | "native";

/**
 * The providers each role has a native client for (`@eidolon/providers/stt`, `/speech-stream`,
 * `/realtime`).
 */
const NATIVE_CLIENTS: Readonly<Record<"hearing" | "voice" | "realtime", ReadonlySet<ProviderId>>> =
  {
    hearing: new Set(["soniox", "deepgram", "elevenlabs", "openai"]),
    voice: new Set(["fish", "elevenlabs", "cartesia", "soniox", "minimax", "openai"]),
    realtime: new Set(["openai", "xai"]),
  };

let warnedAbout: string | null = null;

/** EIDOLON_VOICE_ENGINE: pipedog unless it says native. Any other value warns once. */
export function voiceEngineFromEnv(): VoiceEngine {
  const value = envStr("EIDOLON_VOICE_ENGINE", "pipedog");
  if (value === "pipedog" || value === "native") return value;
  if (warnedAbout !== value) {
    warnedAbout = value;
    logger.warning(
      `EIDOLON_VOICE_ENGINE=${pyRepr(value)} is neither pipedog nor native; calls run on pipedog`,
    );
  }
  return "pipedog";
}

/**
 * Null when the call can run on the native engine as `persona`, a call inside a chat's, or else as
 * the persona whose scope it runs in; else why it runs on pipedog, logged. Settings that can't be
 * read fail the call on pipedog, as they do today. With `group`, the personas of a group call,
 * which only the native engine runs: null when `persona` can hear for them all and each can speak,
 * else why the call can't run, logged.
 */
export function nativeCanRun(persona?: string, group?: readonly string[]): string | null {
  let reason: string | null;
  try {
    if (group !== undefined) reason = groupReason(persona ?? activePersona().id, group);
    else reason = persona === undefined ? pipedogReason() : withPersona(persona, pipedogReason);
  } catch (error) {
    reason = errorText(error);
  }
  if (reason !== null) {
    logger.info(
      group === undefined
        ? `[voice] This call runs on pipedog: ${reason}`
        : `[voice] This group call can't run: ${reason}`,
    );
  }
  return reason;
}

function pipedogReason(): string | null {
  const realtime = select("realtime");
  // A realtime model hears and speaks for her: her hearing and voice roles aren't read.
  const roles = realtime === null ? (["hearing", "voice"] as const) : (["realtime"] as const);
  return unsupported(roles);
}

/** The first of `roles`, in the persona scope it runs in, with no native client: why, or null. */
function unsupported(roles: readonly ("hearing" | "voice" | "realtime")[]): string | null {
  for (const role of roles) {
    const selection = selectRequired(role);
    if (!NATIVE_CLIENTS[role].has(selection.provider.id)) {
      return `${selection.provider.name}'s ${selection.role.label} isn't native yet`;
    }
  }
  return null;
}

/**
 * The first of `personas` whose calls a realtime model runs: she can't join a group call. One whose
 * settings can't say is passed over, for the call's own checks to fail.
 */
export function realtimeIn(personas: readonly string[]): string | null {
  const realtime = (persona: string) => {
    try {
      return withPersona(persona, () => select("realtime") !== null);
    } catch {
      return false;
    }
  };
  return personas.find(realtime) ?? null;
}

/** Why `host` can't hear a group call of `personas`, each speaking in her own voice; or null. */
function groupReason(host: string, personas: readonly string[]): string | null {
  const realtime = realtimeIn(personas);
  if (realtime !== null)
    return `${realtime}'s calls run on a realtime model, which can't join a group call`;
  for (const persona of personas) {
    const reason = withPersona(persona, () =>
      unsupported(persona === host ? ["hearing", "voice"] : ["voice"]),
    );
    if (reason !== null) return reason;
  }
  return personas.includes(host) ? null : `${host} isn't in the call`;
}

/** Starts the call an offer asks for, bound to `binding` when it is a call inside a chat. */
export type StartSession<C, B = never> = (
  connection: C,
  admission: AllowedOffer,
  binding?: B,
) => Promise<void>;

/**
 * What each offer starts. Under pipedog it is `sessions.pipedog` itself, so calls run as they did
 * before the switch existed; under native, each offer asks nativeCanRun, as the binding's persona
 * for a call inside a chat. A group call runs natively whatever it answers, as nothing else runs
 * one: the call checks its personas as it starts, and fails if it must.
 */
export function sessionStarter<C, B extends { readonly persona: string } = never>(
  engine: VoiceEngine,
  sessions: { readonly pipedog: StartSession<C, B>; readonly native: StartSession<C, B> },
): StartSession<C, B> {
  if (engine === "pipedog") return sessions.pipedog;
  return (connection, admission, binding) =>
    isGroupCall(binding) || nativeCanRun(binding?.persona) === null
      ? sessions.native(connection, admission, binding)
      : sessions.pipedog(connection, admission, binding);
}

/** Never aborts: the signalling server's close disconnects every peer, which ends their calls. */
const NO_SHUTDOWN = new AbortController().signal;

/**
 * A call on the native engine, logged as pipedog's sessions start; bound to `binding`, it runs as
 * her and reports to its hooks as pipedog's sessions do. Never rejects: a call that can't start
 * logs `Bot session failed: …`, which the local app's status reads, and disconnects. `newLog`
 * makes an unbound or single-persona call's log; the twin harness passes its own to read it at the
 * end.
 */
export async function runNativeSafely(
  transport: CallTransport,
  admission: Pick<AllowedOffer, "user" | "token" | "requestData">,
  deps: CallDeps,
  binding?: AnyCallBinding,
  newLog: (header: ChatHeader) => CallLog = memoryCallLog,
): Promise<void> {
  let reason: CloseReason = "error";
  try {
    reason =
      binding === undefined
        ? await runNative(transport, admission, deps, newLog)
        : await withPersona(binding.persona, () =>
            runNative(transport, admission, deps, newLog, binding),
          );
  } catch (error) {
    logger.error(`Bot session failed: ${errorText(error)}`, error);
    await transport.disconnect().catch((e: unknown) => {
      logger.warning(`Closing the failed session's connection failed: ${errorText(e)}`);
    });
  }
  if (binding !== undefined) reportEnd(binding, reason);
}

/** The call, as the persona in scope; rejects when it can't be planned. */
async function runNative(
  transport: CallTransport,
  admission: Pick<AllowedOffer, "user" | "token" | "requestData">,
  deps: CallDeps,
  newLog: (header: ChatHeader) => CallLog,
  binding?: AnyCallBinding,
): Promise<CloseReason> {
  logSessionStart(admission);
  const id = Bun.randomUUIDv7();
  const host = binding?.persona ?? activePersona().id;
  let call: BoundCall;
  let group = false;
  if (isGroupCall(binding)) {
    // The chat's own header and events, under the call's id: every persona in it answers.
    const { chat } = binding;
    const reason = nativeCanRun(host, summarize(chat.header, chat.events).participants);
    if (reason !== null) throw new Error(reason);
    const log = memoryCallLog({ ...chat.header, id }, chat.events);
    call = bindGroupCall(binding, log, transport, deps);
    group = true;
  } else {
    const header: ChatHeader = {
      format: CHAT_FORMAT,
      id,
      createdAt: Date.now(),
      participants: [host],
    };
    const log = newLog(header);
    call =
      binding === undefined
        ? { log, transport, deps, close: () => {} }
        : bindCall(binding, log, transport, deps);
  }
  const realtime = !group && select("realtime") !== null;
  try {
    return await runVoiceCall(
      call.transport,
      {
        id,
        host,
        viewer: admission.user,
        log: call.log,
        greet: !group,
        realtime,
        ...(group ? { group } : {}),
      },
      call.deps,
      NO_SHUTDOWN,
    );
  } finally {
    call.close();
  }
}
