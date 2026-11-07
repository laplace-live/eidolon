// Home's memory panel: what the active persona remembers of the viewer, or why it can't be read.
import { ApiError, type Memory, type MemoryStatus } from "@/lib/api";

export type MemoryView = "off" | "down" | "loading" | "failed" | "list";

/**
 * What the panel shows. A 503 is Qdrant not answering; until the list answers, the last status
 * probe already says so.
 */
export function memoryView(
  memory: MemoryStatus,
  list: { readonly status: "pending" | "error" | "success"; readonly error: unknown },
): MemoryView {
  if (!memory.configured) return "off";
  if (list.status === "success") return "list";
  if (list.status === "error") {
    return list.error instanceof ApiError && list.error.status === 503 ? "down" : "failed";
  }
  return memory.reachable === false ? "down" : "loading";
}

/** How many the list shows before "Show all": the newest ones. */
export const MEMORIES_SHOWN = 8;

function timeOf(memory: Memory): number {
  const at = Date.parse(memory.updated_at ?? memory.created_at ?? "");
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
}

/** The memories that say something, newest first. */
export function shownMemories(memories: readonly Memory[]): Memory[] {
  return memories
    .filter((memory) => (memory.memory ?? "").trim() !== "")
    .sort((a, b) => timeOf(b) - timeOf(a));
}
