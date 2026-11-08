import type { ContextProvider } from "@eidolon/core";

/** A mem0 memory as stored in Qdrant, in mem0's own payload schema. */
export interface MemoryItem {
  id: string;
  memory: string;
  hash: string | null;
  metadata: Record<string, unknown> | null;
  score?: number;
  created_at: string | null;
  updated_at: string | null;
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  actor_id?: string;
  role?: string;
  /** Whatever truthy value the extraction returned; usually "user" or "assistant". */
  attributed_to?: unknown;
  expiration_date?: unknown;
}

/** Pipecat's Mem0MemoryService as a context provider: search and inject, then store. */
export interface MemoryProvider extends ContextProvider {
  /** Every memory for this viewer, newest first, for the greeting. Rejects on store errors; logs nothing. */
  newestFirst(): Promise<MemoryItem[]>;
}

/** One memory as `/api/memories` lists it. */
export interface MemorySummary {
  id: string | null;
  memory: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** null today; never undefined, which JSON.stringify would drop. Key order is the body's. */
  categories: readonly string[] | null;
}

export type AdminOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "unavailable" | "failed"; readonly error: unknown };

/**
 * What `/api/memories` and `/api/memories/forget` run. Never rejects and logs nothing: apps/bot
 * owns auth, HTTP, and every `[memory-admin]` log line, taking failures from `error`.
 */
export interface MemoryAdmin {
  /** `agentId` narrows the scope to one agent's memories, as the local app's per-persona ones. */
  list(userId: string, agentId?: string): Promise<AdminOutcome<MemorySummary[]>>;
  forget(userId: string, agentId?: string): Promise<AdminOutcome<void>>;
}
