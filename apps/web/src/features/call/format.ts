/** `mm:ss`, or `h:mm:ss` from an hour on. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mmss = [Math.floor(total / 60) % 60, total % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function graphemes(text: string): string[] {
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
    ({ segment }) => segment,
  );
}

/** What an avatar without a picture shows: a short name whole, else its initials. */
export function monogram(shortName: string, name: string): string {
  const source = shortName.trim() || name.trim();
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length > 1)
    return words
      .slice(0, 2)
      .map((word) => graphemes(word)[0]!)
      .join("")
      .toUpperCase();
  const letters = graphemes(source);
  if (letters.length <= 2) return source;
  return letters[0]!.toUpperCase();
}
