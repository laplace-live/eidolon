// Whether the viewer can call every persona in a chat at once: a persona whose calls run on a
// realtime model or whose speech is turned off can't join a group call.
import type { ParticipantId } from "@eidolon/chat";
import { withPersona } from "@eidolon/config";
import { ProviderConfigError, realtimeIn, roleById, selectedAccount } from "@eidolon/providers";
import { personaCallsDisabled } from "./call-keys.ts";

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
  if (on !== null) {
    return {
      status: 409,
      code: "realtime-in-group",
      message: `${on} talks through a realtime model, which can't join a group call`,
    };
  }
  const muted = personas.find((persona) =>
    withPersona(persona, () => {
      try {
        return selectedAccount(roleById("voice")) === null;
      } catch (error) {
        if (error instanceof ProviderConfigError) return false;
        throw error;
      }
    }),
  );
  if (muted !== undefined) {
    return {
      status: 400,
      code: "bad-request",
      message: `${muted}'s voice is turned off, so she can't join a group call`,
    };
  }
  if (personas.every(personaCallsDisabled)) {
    return {
      status: 400,
      code: "bad-request",
      message: "No participant in this chat has voice calls enabled",
    };
  }
  return null;
}
