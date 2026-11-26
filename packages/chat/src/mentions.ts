import type { ParticipantId } from "./format.ts";

/** A participant as an `@` names her: her identity's name or short name. */
export interface MentionTarget {
  readonly id: ParticipantId;
  readonly name: string;
  readonly shortName: string;
}

const LATIN_WORD = /[A-Za-z0-9_]/;
const ALL_MENTIONS = ["全体成员", "全体", "所有人", "大家", "everyone", "all"] as const;

function matchesMention(text: string, from: number, name: string, minLength: number): boolean {
  if (name === "" || name.length <= minLength) return false;
  const end = from + name.length;
  if (text.slice(from, end).toLowerCase() !== name.toLowerCase()) return false;
  return !(LATIN_WORD.test(name.at(-1) as string) && LATIN_WORD.test(text[end] ?? ""));
}

/**
 * The participants `text` @-mentions (`@` or `＠`, then a name, short name, or broadcast alias like
 * `@all`, `@everyone`, `@全体`, `@全体成员`, `@所有人`, or `@大家`, case-blind), in the order first
 * mentioned. Chinese runs on without a space, so the longest name that follows an `@` wins, and
 * only a name ending in a Latin letter or digit must end where the word does: `@Kenny` is no
 * mention of Ken.
 */
export function parseMentions(
  text: string,
  participants: readonly MentionTarget[],
): ParticipantId[] {
  const found = new Set<ParticipantId>();
  for (const at of text.matchAll(/[@＠]/g)) {
    const from = at.index + 1;
    let best:
      | { readonly kind: "one"; readonly id: ParticipantId; readonly length: number }
      | { readonly kind: "all"; readonly length: number }
      | null = null;
    for (const participant of participants) {
      for (const name of [participant.name, participant.shortName]) {
        if (!matchesMention(text, from, name, best?.length ?? 0)) continue;
        best = { kind: "one", id: participant.id, length: name.length };
      }
    }
    for (const alias of ALL_MENTIONS) {
      if (!matchesMention(text, from, alias, best?.length ?? 0)) continue;
      best = { kind: "all", length: alias.length };
    }
    if (best === null) continue;
    if (best.kind === "one") found.add(best.id);
    else for (const participant of participants) found.add(participant.id);
  }
  return [...found];
}
