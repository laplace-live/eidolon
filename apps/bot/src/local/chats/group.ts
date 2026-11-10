// Whether the viewer can call every persona in a chat at once: a persona whose calls run on a
// realtime model can't join a group call.
import type { ParticipantId } from "@eidolon/chat";
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
  const on = realtimeIn(personas);
  if (on === null) return null;
  return {
    status: 409,
    code: "realtime-in-group",
    message: `${on} talks through a realtime model, which can't join a group call`,
  };
}
