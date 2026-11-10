// Whether the viewer can call every persona in a chat at once: only the native voice engine runs a
// group call, and a persona whose calls run on a realtime model can't join one. The engine and the
// realtime role are read as runtime's voiceEngineFromEnv and realtimeIn read them, without loading
// the runtime here.
import type { ParticipantId } from "@eidolon/chat";
import { envStr, withPersona } from "@eidolon/config";
import { select } from "@eidolon/providers";

export interface GroupCallRefusal {
  readonly status: 400 | 409;
  readonly code: "bad-request" | "realtime-in-group";
  readonly message: string;
}

function realtime(persona: ParticipantId): boolean {
  try {
    return withPersona(persona, () => select("realtime") !== null);
  } catch {
    // Settings that can't say fail the call's own checks.
    return false;
  }
}

/** Why the chat's `personas` can't be called together now; null when they can. */
export function groupCallRefusal(personas: readonly ParticipantId[]): GroupCallRefusal | null {
  if (personas.length < 2) {
    return { status: 400, code: "bad-request", message: "A group call needs two personas or more" };
  }
  if (envStr("EIDOLON_VOICE_ENGINE", "pipedog") !== "native") {
    return {
      status: 400,
      code: "bad-request",
      message: "Group calls need the native voice engine: set EIDOLON_VOICE_ENGINE=native",
    };
  }
  const on = personas.find(realtime);
  if (on === undefined) return null;
  return {
    status: 409,
    code: "realtime-in-group",
    message: `${on} talks through a realtime model, which can't join a group call`,
  };
}
