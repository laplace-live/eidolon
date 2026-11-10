// Which voice engine answers a call: pipedog's pipeline, or the native loop in @eidolon/voice over
// @eidolon/webrtc. EIDOLON_VOICE_ENGINE picks one at boot, for every call. docs/voice-engine.md.
import type { AllowedOffer } from "@eidolon/access";
import { CHAT_FORMAT, type ChatHeader, summarize } from "@eidolon/chat";
import { activePersona, envStr, errorText, logger, pyRepr, withPersona } from "@eidolon/config";
import { select } from "@eidolon/providers";
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

/** Why `host` can't hold a group call of `personas`, logged; null when she can. */
export function groupCallProblem(host: string, personas: readonly string[]): string | null {
  const realtime = realtimeIn(personas);
  const reason =
    realtime !== null
      ? `${realtime}'s calls run on a realtime model, which can't join a group call`
      : personas.includes(host)
        ? null
        : `${host} isn't in the call`;
  if (reason !== null) logger.info(`[voice] This group call can't run: ${reason}`);
  return reason;
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
    const reason = groupCallProblem(host, summarize(chat.header, chat.events).participants);
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
