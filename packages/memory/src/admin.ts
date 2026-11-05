// The framework-free half of `/api/memories` and `/api/memories/forget`. Forgetting mid-call wipes
// only what is already stored: a live session keeps writing new turns until it ends, so the
// frontend hangs up for a clean wipe (docs/memory-admin.md); the backend never force-disconnects.
import { buildMemoryConfig } from "./config.ts";
import { LIST_LIMIT, type MemoryEngine, type SharedEngine } from "./engine.ts";
import type { AdminOutcome, MemoryAdmin, MemoryItem, MemorySummary } from "./types.ts";

/**
 * The fields the frontend may see. mem0 also returns bookkeeping (hash, score, ids, the metadata
 * blob) that must never surface. Its OSS projection has no top-level categories, so that is null.
 */
function summary(item: MemoryItem): MemorySummary {
  return {
    id: item.id ?? null,
    memory: item.memory ?? null,
    created_at: item.created_at ?? null,
    updated_at: item.updated_at ?? null,
    categories: null,
  };
}

export function createMemoryAdmin(engines: SharedEngine): MemoryAdmin {
  async function run<T>(op: (engine: MemoryEngine) => Promise<T>): Promise<AdminOutcome<T>> {
    let engine: MemoryEngine;
    try {
      engine = (await engines.get(buildMemoryConfig())).engine;
    } catch (error) {
      return { ok: false, reason: "unavailable", error };
    }
    try {
      return { ok: true, value: await op(engine) };
    } catch (error) {
      return { ok: false, reason: "failed", error };
    }
  }
  return {
    list: (userId, agentId) =>
      run(async (engine) =>
        // Without the explicit cap mem0 lists 20, silently understating a chatty viewer.
        (await engine.getAll({ filters: { userId, agentId }, topK: LIST_LIMIT })).map(summary),
      ),
    forget: (userId, agentId) =>
      run(async (engine) => {
        await engine.deleteAll({ userId, agentId });
      }),
  };
}
