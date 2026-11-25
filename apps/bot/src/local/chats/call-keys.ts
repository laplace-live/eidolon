// Whether a chat's Call can call anyone: setup lets her hearing's and voice's keys wait, and a call
// without one fails only once it has started.
import type { ParticipantId } from "@eidolon/chat";
import { withPersona } from "@eidolon/config";
import { accountsFor } from "@eidolon/providers";
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
