// The viewer's voice messages are heard through the hearing role of the chat's first persona, the
// engine's voiceHearer.
import type { ParticipantId } from "@eidolon/chat";
import { withPersona } from "@eidolon/config";
import { hasKey, missingKey, ProviderConfigError, selectRequired } from "@eidolon/providers";

/** A voice message that couldn't be heard; its `cause` is why. */
export class HearingFailed extends Error {
  override name = "HearingFailed";

  constructor(cause: unknown) {
    super("The voice message couldn't be heard", { cause });
  }
}

/**
 * Why the viewer can't send a chat of `participants` a voice message, in English: its first
 * persona's hearing role has no key, or can't be resolved. null when they can.
 */
export function hearingRefusal(participants: readonly ParticipantId[]): string | null {
  const [hearer] = participants;
  if (hearer === undefined) return null;
  const problem = withPersona(hearer, () => {
    try {
      const selection = selectRequired("hearing");
      return hasKey(selection) ? null : missingKey(selection).message;
    } catch (error) {
      if (error instanceof ProviderConfigError) return error.message;
      throw error;
    }
  });
  if (problem === null) return null;
  const whose = participants.length > 1 ? `${hearer}'s` : "Her";
  return `${whose} hearing role can't hear a voice message. ${problem}`;
}
