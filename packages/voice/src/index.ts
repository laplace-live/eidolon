// eidolon's own voice engine: a call's loop around @eidolon/engine, without pipedog. Only
// packages/runtime imports it.
import type { ChatHeader } from "@eidolon/chat";
import type { CallDeps, CallLog, CallPlan, CallTransport, CloseReason } from "./types.ts";

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

/** Runs a call to its end. Never rejects: a call that fails to start disconnects. */
export async function runVoiceCall(
  _transport: CallTransport,
  _plan: CallPlan,
  _deps: CallDeps,
  _signal: AbortSignal,
): Promise<CloseReason> {
  throw new Error("not implemented in this phase");
}

/** Loads the ONNX models so the first call doesn't wait for them. */
export async function warmVoiceModels(_models: CallDeps["models"]): Promise<void> {
  throw new Error("not implemented in this phase");
}

/** A call log kept in memory and dropped at the call's end, as production keeps no chats. */
export function memoryCallLog(_header: ChatHeader): CallLog {
  throw new Error("not implemented in this phase");
}
