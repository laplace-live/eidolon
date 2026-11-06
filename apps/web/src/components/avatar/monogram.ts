const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * The letters an avatar without a picture shows: up to two CJK characters (奶绿), else the
 * initials of the first two words (MG), else one letter.
 */
export function monogram(shortName: string): string {
  const words = shortName.trim().split(/\s+/u).filter(Boolean);
  const [first, second] = words;
  if (!first) return "?";
  if (WIDE.test(first)) return graphemes(words.join("")).slice(0, 2).join("");
  if (!second) return (graphemes(first)[0] ?? "?").toUpperCase();
  return `${graphemes(first)[0]}${graphemes(second)[0]}`.toUpperCase();
}
