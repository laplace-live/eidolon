/** A persona's studio, or one of its tabs. */
export function studioPath(persona: string, tab?: string): string {
  const studio = `/personas/${encodeURIComponent(persona)}`;
  return tab === undefined ? studio : `${studio}/${tab}`;
}
