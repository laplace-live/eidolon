// The only package that imports @pipedog/*. No pipedog type crosses this file.
import type { IceService } from "@eidolon/turn";
import { productionSessionDeps } from "./session/defaults.ts";
import { runSessionSafely } from "./session/session.ts";
import { createSignallingServerWith, type SignallingServer } from "./webrtc/signalling.ts";

export { warmAudioModels } from "./audio.ts";
export { configureLogging } from "./logging.ts";
export { BOT_ABOUT } from "./rtvi.ts";
export type { CallBinding, CallClient, CallEnd, TranscriptLine } from "./session/session.ts";
export type { SignallingResult, SignallingServer } from "./webrtc/signalling.ts";

export function createSignallingServer(options: {
  ice: Pick<IceService, "serverPlan">;
}): SignallingServer {
  return createSignallingServerWith(options, {
    startSession: (connection, admission, binding) =>
      runSessionSafely(connection, admission, productionSessionDeps, binding),
  });
}
