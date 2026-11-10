// The bridge from apps/bot to the voice engine: the only package that imports @eidolon/voice and
// @eidolon/webrtc.
import { type LogLevel, logger } from "@eidolon/config";
import type { IceService } from "@eidolon/turn";
import { voiceModels, warmVoiceModels } from "@eidolon/voice";
import {
  type SignallingServer as PeerSignallingServer,
  peerCallTransport,
  createSignallingServerWith as webrtcSignallingServer,
} from "@eidolon/webrtc";
import type { AnyCallBinding } from "./native/binding.ts";
import { productionCallDeps } from "./native/deps.ts";
import { runNativeSafely } from "./native/engine.ts";

export type { SignallingResult } from "@eidolon/webrtc";
export type {
  AnyCallBinding,
  CallBinding,
  CallClient,
  CallEnd,
  GroupCallBinding,
  TranscriptLine,
} from "./native/binding.ts";
export { BOT_ABOUT } from "./rtvi.ts";

/** POST and PATCH /api/offer; an offer may bind its call to a chat. */
export type SignallingServer = PeerSignallingServer<AnyCallBinding>;

/** Sets the logger's level. */
export function configureLogging(options: { level: LogLevel }): void {
  logger.setLevel(options.level);
}

/** Loads the Silero VAD and Smart Turn models and the resampler before the first call needs them. */
export function warmAudioModels(): Promise<void> {
  return warmVoiceModels(voiceModels());
}

/** The signalling server: each offer it answers starts a call over @eidolon/webrtc's peers. */
export function createSignallingServer(options: {
  ice: Pick<IceService, "serverPlan">;
}): SignallingServer {
  return webrtcSignallingServer<AnyCallBinding>(options, {
    startSession: (peer, admission, binding) =>
      runNativeSafely(peerCallTransport(peer), admission, productionCallDeps, binding),
  });
}
