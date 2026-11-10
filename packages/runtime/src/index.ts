// The only package that imports @pipedog/* and @eidolon/voice. No pipedog type crosses this file.
import { errorText, logger } from "@eidolon/config";
import type { IceService } from "@eidolon/turn";
import { isGroupCall, reportEnd } from "./native/binding.ts";
import { productionCallDeps } from "./native/deps.ts";
import { runNativeSafely, sessionStarter, voiceEngineFromEnv } from "./native/engine.ts";
import { pipedogCallTransport } from "./native/transport_pipedog.ts";
import { productionSessionDeps } from "./session/defaults.ts";
import { runSessionSafely } from "./session/session.ts";
import { createSignallingServerWith, type SignallingServer } from "./webrtc/signalling.ts";

export { warmAudioModels } from "./audio.ts";
export { configureLogging } from "./logging.ts";
export type { AnyCallBinding, GroupCallBinding } from "./native/binding.ts";
export { BOT_ABOUT } from "./rtvi.ts";
export type { CallBinding, CallClient, CallEnd, TranscriptLine } from "./session/session.ts";
export type { SignallingResult, SignallingServer } from "./webrtc/signalling.ts";

/** Reads EIDOLON_VOICE_ENGINE once, here: every offer this server answers runs on that engine. */
export function createSignallingServer(options: {
  ice: Pick<IceService, "serverPlan">;
}): SignallingServer {
  return createSignallingServerWith(options, {
    startSession: sessionStarter(voiceEngineFromEnv(), {
      pipedog: async (connection, admission, binding) => {
        if (!isGroupCall(binding)) {
          return runSessionSafely(connection, admission, productionSessionDeps, binding);
        }
        // Its callers offer a group call only to a native engine: pipedog can't run one.
        logger.error("Bot session failed: a group call needs EIDOLON_VOICE_ENGINE=native");
        await connection.disconnect().catch((error: unknown) => {
          logger.warning(`Closing the failed session's connection failed: ${errorText(error)}`);
        });
        reportEnd(binding, "error");
      },
      native: (connection, admission, binding) =>
        runNativeSafely(pipedogCallTransport(connection), admission, productionCallDeps, binding),
    }),
  });
}
