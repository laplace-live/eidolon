import type { ParticipantId } from "./format.ts";

/** A participant as an `@` names her: her identity's name or short name. */
export interface MentionTarget {
  readonly id: ParticipantId;
  readonly name: string;
  readonly shortName: string;
}

const LATIN_WORD = /[A-Za-z0-9_]/;

/**
 * The participants `text` @-mentions (`@` or `＠`, then a name or short name, case-blind), in the
 * order first mentioned. Chinese runs on without a space, so the longest name that follows an `@`
 * wins, and only a name ending in a Latin letter or digit must end where the word does: `@Kenny` is
 * no mention of Ken.
 */
export function parseMentions(
  text: string,
  participants: readonly MentionTarget[],
): ParticipantId[] {
  const found: ParticipantId[] = [];
  for (const at of text.matchAll(/[@＠]/g)) {
    const from = at.index + 1;
    let best: { id: ParticipantId; length: number } | null = null;
    for (const participant of participants) {
      for (const name of [participant.name, participant.shortName]) {
        if (name === "" || name.length <= (best?.length ?? 0)) continue;
        const end = from + name.length;
        if (text.slice(from, end).toLowerCase() !== name.toLowerCase()) continue;
        if (LATIN_WORD.test(name.at(-1) as string) && LATIN_WORD.test(text[end] ?? "")) continue;
        best = { id: participant.id, length: name.length };
      }
    }
    if (best !== null && !found.includes(best.id)) found.push(best.id);
  }
  return found;
}
