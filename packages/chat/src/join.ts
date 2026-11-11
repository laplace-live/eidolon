const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

/** The space two pieces of text need between them: none beside a space or CJK. */
export function separator(left: string, right: string): "" | " " {
  const before = left.at(-1);
  const after = right[0];
  if (before === undefined || after === undefined) return "";
  if (/\s/.test(before) || /\s/.test(after) || CJK.test(before) || CJK.test(after)) return "";
  return " ";
}

/**
 * Pieces of speech as one text, trimmed: a call's STT finals as the viewer's line, or the segments
 * she spoke as hers. pipedog's `concatenateAggregatedText` put a space between any two, CJK too.
 */
export function joinSegments(parts: readonly string[]): string {
  return parts.reduce((text, part) => text + separator(text, part) + part, "").trim();
}
