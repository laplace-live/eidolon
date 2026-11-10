// eidolon's own voice engine: a call's loop around @eidolon/engine, without pipedog. Only
// packages/runtime imports it.
import { errorText, logger } from "@eidolon/config";
import { withUsageScope } from "@eidolon/providers";
import { runCascadeCall } from "./call/cascade.ts";
import { resampler } from "./dsp/resampler/index.ts";
import { sharedSession } from "./input/onnx.ts";
import type { CallDeps, CallPlan, CallTransport, CloseReason } from "./types.ts";

export { memoryCallLog } from "./call/log.ts";
export type {
  CallDeps,
  CallLog,
  CallPlan,
  CallTransport,
  Clock,
  CloseReason,
  CursorEvent,
  EarEvent,
  JoinSegments,
  Pcm,
  PcmSource,
  ReplySpeech,
  Speaker,
  Tag,
} from "./types.ts";

/**
 * Runs a call to its end, everything it spends billed to it. Never rejects: a call that fails logs
 * `Bot session failed: …`, which the local app's status reads, and disconnects.
 */
export function runVoiceCall(
  transport: CallTransport,
  plan: CallPlan,
  deps: CallDeps,
  signal: AbortSignal,
): Promise<CloseReason> {
  return withUsageScope({ source: "call", session: plan.id }, async () => {
    try {
      if (plan.realtime) throw new Error("A realtime persona's calls run on pipedog for now");
      return await runCascadeCall(transport, plan, deps, signal);
    } catch (error) {
      logger.error(`Bot session failed: ${errorText(error)}`, error);
      await transport.disconnect().catch((e: unknown) => {
        logger.warning(`Closing the failed session's connection failed: ${errorText(e)}`);
      });
      return "error";
    }
  });
}

/** Loads the VAD and Smart Turn models and the resampler, so the first call doesn't wait. */
export async function warmVoiceModels(models: CallDeps["models"]): Promise<void> {
  resampler();
  await Promise.all([sharedSession(models.silero), sharedSession(models.smartTurn)]);
}
