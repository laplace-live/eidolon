// Per-viewer long-term memory: mem0's OSS engine over Qdrant, the context provider the pipeline
// runs, and the admin operations behind /api/memories.
import { createMemoryAdmin } from "./admin.ts";
import { qdrantHost } from "./config.ts";
import { SharedEngine } from "./engine.ts";
import { openMemoryProvider } from "./provider.ts";
import type { MemoryAdmin, MemoryProvider } from "./types.ts";

export type {
  AdminOutcome,
  MemoryAdmin,
  MemoryItem,
  MemoryProvider,
  MemorySummary,
} from "./types.ts";

const engines = new SharedEngine();

/**
 * `MEM0_QDRANT_HOST` is set (trimmed, non-empty). Deliberately not a reachability check: Qdrant
 * being down is handled where the engine opens, so a restart-order blip degrades a session
 * instead of failing the boot.
 */
export function isMemoryConfigured(): boolean {
  return qdrantHost() !== "";
}

/**
 * The provider for one logged-in viewer. `userId` is `String(mid)`. Reads MEM0_AGENT_ID,
 * MEM0_RUN_ID and the search settings itself. Runtime calls it only when `isMemoryConfigured()`;
 * it rejects when memory is unusable (not configured, Qdrant unreachable, no embedding key,
 * out-of-range MEM0_SEARCH_*). Never builds a Qdrant client from a blank host: the JS client
 * would default to 127.0.0.1.
 */
export function createMemoryProvider(options: { userId: string }): Promise<MemoryProvider> {
  return openMemoryProvider(options, engines);
}

/** null when memory is not configured. */
export function memoryAdmin(): MemoryAdmin | null {
  return isMemoryConfigured() ? createMemoryAdmin(engines) : null;
}
