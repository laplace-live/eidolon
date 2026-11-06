// Whether her facts index still matches her fact files: files changed since it was built, and
// files it was built from that are gone, which only another ingest-facts drops.
import type { FactFile, FactsResponse, IndexTable } from "@/lib/api";

export interface FactsState {
  /** Files the patterns pick. */
  readonly matched: number;
  /** Picked files that differ from what the index was built from. */
  readonly changed: number;
  /** Files the index still holds that were deleted or are no longer picked, sorted. */
  readonly gone: readonly string[];
}

/**
 * Whether a fact file is in the index, as far as the page can tell. A table without a build record
 * (built by the Python tools) lists no sources, so the server can't report it among `removed`.
 */
export function wasIndexed(
  file: Pick<FactFile, "matched" | "changed">,
  table: Pick<IndexTable, "built" | "rows"> | undefined,
): boolean {
  if (!file.matched || table?.built !== true) return false;
  return table.rows === null || !file.changed;
}

/** `deleted`: files deleted on this page while wasIndexed said they were in the index. */
export function factsState(
  facts: Pick<FactsResponse, "files" | "removed">,
  deleted: readonly string[],
): FactsState {
  const present = new Set(facts.files.map((file) => file.name));
  const gone = new Set(facts.removed);
  for (const name of deleted) if (!present.has(name)) gone.add(name);
  return {
    matched: facts.files.filter((file) => file.matched).length,
    changed: facts.files.filter((file) => file.matched && file.changed).length,
    gone: [...gone].sort(),
  };
}

/** The line beside "Index facts": a locale key and its values. */
export function factsHint(state: FactsState): {
  readonly key: string;
  readonly vars?: { readonly count: number };
} {
  if (state.matched === 0) return { key: "studio.facts.nothingMatched" };
  if (state.changed > 0)
    return { key: "studio.facts.changedCount", vars: { count: state.changed } };
  if (state.gone.length > 0) {
    return { key: "studio.facts.goneCount", vars: { count: state.gone.length } };
  }
  return { key: "studio.facts.ingestHelp" };
}
