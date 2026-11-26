// Per-viewer long-term memory: mem0's OSS extraction engine over in-process Zvec, the context
// provider each turn runs, and the admin operations behind /api/memories.
import { createMemoryAdmin } from "./admin.ts";
import { isMemoryConfigured } from "./config.ts";
import { SharedEngine } from "./engine.ts";
import { openMemoryProvider } from "./provider.ts";
import type { MemoryAdmin, MemoryProvider } from "./types.ts";

export { isMemoryConfigured } from "./config.ts";
export { MEM0_LABEL, MEM0_STORE_KEY } from "./provider.ts";
export type {
  AdminOutcome,
  MemoryAdmin,
  MemoryItem,
  MemoryProvider,
  MemorySummary,
} from "./types.ts";
export { closeMemoryStores } from "./zvec.ts";

const engines = new SharedEngine();

/**
 * The provider for one logged-in viewer. `userId` is `String(mid)`. Reads MEM0_AGENT_ID,
 * MEM0_RUN_ID and the search settings itself. Runtime calls it only when `isMemoryConfigured()`;
 * it rejects when memory is unusable (not enabled, store unwritable, no embedding key,
 * out-of-range MEM0_SEARCH_*).
 */
export function createMemoryProvider(options: { userId: string }): Promise<MemoryProvider> {
  return openMemoryProvider(options, engines);
}

/** null when memory is not configured. */
export function memoryAdmin(): MemoryAdmin | null {
  return isMemoryConfigured() ? createMemoryAdmin(engines) : null;
}
