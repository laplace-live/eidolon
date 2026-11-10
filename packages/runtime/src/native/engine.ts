// Which voice engine answers a call: pipedog's pipeline, or the native loop in @eidolon/voice.
// EIDOLON_VOICE_ENGINE picks one at boot; under native, an offer whose call can't run natively yet
// still goes to pipedog. docs/voice-engine.md.
import type { AllowedOffer } from "@eidolon/access";
import { CHAT_FORMAT, type ChatHeader } from "@eidolon/chat";
import { activePersona, envStr, errorText, logger, pyRepr } from "@eidolon/config";
import { type ProviderId, select, selectRequired } from "@eidolon/providers";
import { type CallDeps, type CallTransport, memoryCallLog, runVoiceCall } from "@eidolon/voice";
import { logSessionStart } from "../session/start.ts";

export type VoiceEngine = "pipedog" | "native";

/** The providers each role has a native client for (`@eidolon/providers/stt`, `/speech-stream`). */
const NATIVE_CLIENTS: Readonly<Record<"hearing" | "voice", ReadonlySet<ProviderId>>> = {
  hearing: new Set(["soniox", "deepgram", "elevenlabs", "openai"]),
  voice: new Set(["fish", "elevenlabs", "cartesia", "soniox", "minimax", "openai"]),
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
 * Null when the persona whose scope it runs in can take this call on the native engine; else why
 * it runs on pipedog, logged. Settings that can't be read fail the call on pipedog, as they do
 * today. A call `bound` to a chat always runs on pipedog, which alone takes a `CallBinding`.
 */
export function nativeCanRun(bound = false): string | null {
  const reason = bound ? "it is a call inside a chat" : pipedogReason();
  if (reason !== null) logger.info(`[voice] This call runs on pipedog: ${reason}`);
  return reason;
}

function pipedogReason(): string | null {
  try {
    const realtime = select("realtime");
    if (realtime !== null) return `${realtime.provider.name}'s realtime model voices her`;
    for (const role of ["hearing", "voice"] as const) {
      const selection = selectRequired(role);
      if (!NATIVE_CLIENTS[role].has(selection.provider.id)) {
        return `${selection.provider.name}'s ${selection.role.label} isn't native yet`;
      }
    }
    return null;
  } catch (error) {
    return errorText(error);
  }
}

/** Starts the call an offer asks for, bound to `binding` when it is a call inside a chat. */
export type StartSession<C, B = never> = (
  connection: C,
  admission: AllowedOffer,
  binding?: B,
) => Promise<void>;

/**
 * What each offer starts. Under pipedog it is `sessions.pipedog` itself, so calls run as they did
 * before the switch existed; under native, each offer asks nativeCanRun.
 */
export function sessionStarter<C, B = never>(
  engine: VoiceEngine,
  sessions: { readonly pipedog: StartSession<C, B>; readonly native: StartSession<C> },
): StartSession<C, B> {
  if (engine === "pipedog") return sessions.pipedog;
  return (connection, admission, binding) =>
    nativeCanRun(binding !== undefined) === null
      ? sessions.native(connection, admission)
      : sessions.pipedog(connection, admission, binding);
}

/** Never aborts: the signalling server's close disconnects every peer, which ends their calls. */
const NO_SHUTDOWN = new AbortController().signal;

/**
 * A call on the native engine, logged as pipedog's sessions start. Never rejects: a call that
 * can't start logs `Bot session failed: …`, which the local app's status reads, and disconnects.
 */
export async function runNativeSafely(
  transport: CallTransport,
  admission: Pick<AllowedOffer, "user" | "token" | "requestData">,
  deps: CallDeps,
): Promise<void> {
  try {
    logSessionStart(admission);
    const id = Bun.randomUUIDv7();
    const host = activePersona().id;
    const header: ChatHeader = {
      format: CHAT_FORMAT,
      id,
      createdAt: Date.now(),
      participants: [host],
    };
    await runVoiceCall(
      transport,
      {
        id,
        host,
        viewer: admission.user,
        log: memoryCallLog(header),
        greet: true,
        realtime: select("realtime") !== null,
      },
      deps,
      NO_SHUTDOWN,
    );
  } catch (error) {
    logger.error(`Bot session failed: ${errorText(error)}`, error);
    await transport.disconnect().catch((e: unknown) => {
      logger.warning(`Closing the failed session's connection failed: ${errorText(e)}`);
    });
  }
}
