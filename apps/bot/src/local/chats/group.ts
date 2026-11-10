// Whether the viewer can call every persona in a chat at once: only the native voice engine runs a
// group call, and a persona whose calls run on a realtime model can't join one. The engine is read
// as runtime's voiceEngineFromEnv reads it, without loading the runtime here.
import type { ParticipantId } from "@eidolon/chat";
import { envStr } from "@eidolon/config";
import { realtimeIn } from "@eidolon/providers";

export interface GroupCallRefusal {
  readonly status: 400 | 409;
  readonly code: "bad-request" | "realtime-in-group";
  readonly message: string;
}

/** Why the chat's `personas` can't be called together now; null when they can. */
export function groupCallRefusal(personas: readonly ParticipantId[]): GroupCallRefusal | null {
  if (personas.length < 2) {
    return { status: 400, code: "bad-request", message: "A group call needs two personas or more" };
  }
  if (envStr("EIDOLON_VOICE_ENGINE", "native") === "pipedog") {
    return {
      status: 400,
      code: "bad-request",
      message: "Group calls need the native voice engine, not EIDOLON_VOICE_ENGINE=pipedog",
    };
  }
  const on = realtimeIn(personas);
  if (on === null) return null;
  return {
    status: 409,
    code: "realtime-in-group",
    message: `${on} talks through a realtime model, which can't join a group call`,
  };
}
