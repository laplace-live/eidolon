// Whether a chat's Call can call anyone: setup lets her hearing's and voice's keys wait, and a call
// without one fails only once it has started.
import type { ParticipantId } from "@eidolon/chat";
import { withPersona } from "@eidolon/config";
import { accountsFor, ProviderConfigError, roleById, selectedAccount } from "@eidolon/providers";
import { statusRoles } from "../status.ts";

/** ChatContents' `missingCallKeys` for a chat of `participants`. */
export function missingCallKeys(participants: readonly ParticipantId[]): string[] {
  const lists = participants.map((persona) =>
    withPersona(persona, () =>
      accountsFor(statusRoles())
        .filter((need) => !need.set)
        .map((need) => need.account.name),
    ),
  );
  return lists.some((names) => names.length === 0) ? [] : [...new Set(lists.flat())];
}

/** True when `persona` has hearing or speech turned off without a realtime model. */
export function personaCallsDisabled(persona: ParticipantId): boolean {
  return withPersona(persona, () => {
    try {
      if (selectedAccount(roleById("realtime")) !== null) return false;
      return (
        selectedAccount(roleById("hearing")) === null || selectedAccount(roleById("voice")) === null
      );
    } catch (error) {
      // Broken settings are surfaced when placing a call, not masked as intentionally turned off.
      if (error instanceof ProviderConfigError) return false;
      throw error;
    }
  });
}

/** Participants in `participants` whose voice calls are turned off. */
export function disabledCallPersonas(participants: readonly ParticipantId[]): ParticipantId[] {
  return participants.filter(personaCallsDisabled);
}

/** True when no participant can take a call because hearing or speech is turned off without realtime. */
export function callsDisabled(participants: readonly ParticipantId[]): boolean {
  if (participants.length === 0) return false;
  return participants.every(personaCallsDisabled);
}
