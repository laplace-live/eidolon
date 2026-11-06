/** `mm:ss`, or `h:mm:ss` from an hour on. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mmss = [Math.floor(total / 60) % 60, total % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}
