// The only package that imports @pipedog/* and @eidolon/voice. No pipedog type crosses this file.
import type { IceService } from "@eidolon/turn";
import { productionCallDeps } from "./native/deps.ts";
import { runNativeSafely, sessionStarter, voiceEngineFromEnv } from "./native/engine.ts";
import { pipedogCallTransport } from "./native/transport_pipedog.ts";
import { productionSessionDeps } from "./session/defaults.ts";
import { runSessionSafely } from "./session/session.ts";
import { createSignallingServerWith, type SignallingServer } from "./webrtc/signalling.ts";

export { warmAudioModels } from "./audio.ts";
export { configureLogging } from "./logging.ts";
export { BOT_ABOUT } from "./rtvi.ts";
export type { CallBinding, CallClient, CallEnd, TranscriptLine } from "./session/session.ts";
export type { SignallingResult, SignallingServer } from "./webrtc/signalling.ts";

/** Reads EIDOLON_VOICE_ENGINE once, here: every offer this server answers runs on that engine. */
export function createSignallingServer(options: {
  ice: Pick<IceService, "serverPlan">;
}): SignallingServer {
  return createSignallingServerWith(options, {
    startSession: sessionStarter(voiceEngineFromEnv(), {
      pipedog: (connection, admission, binding) =>
        runSessionSafely(connection, admission, productionSessionDeps, binding),
      native: (connection, admission) =>
        runNativeSafely(pipedogCallTransport(connection), admission, productionCallDeps),
    }),
  });
}
