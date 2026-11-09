// Pipecat's Mem0MemoryService, with content-less messages dropped and a newest-first listing, as a
// context provider. On each context frame it searches with the latest user message, inserts the
// hits as a `developer` message at position 1, and stores the conversation in the background.

import {
  envOptional,
  errorText,
  isPlainObject,
  logger,
  pyRepr,
  pyStr,
  pyStrip,
  raceAbort,
} from "@eidolon/config";
import type { ContextTurn } from "@eidolon/core";
import {
  buildMemoryConfig,
  type MemorySearchSettings,
  memorySearchSettingsFromEnv,
} from "./config.ts";
import {
  type ConversationMessage,
  LIST_LIMIT,
  type MemoryEngine,
  type SharedEngine,
  sortNewestFirst,
} from "./engine.ts";
import type { MemoryScope } from "./scope.ts";
import type { MemoryItem, MemoryProvider } from "./types.ts";

const MEMORY_PREFIX = "Based on previous conversations, I recall: \n\n";
const MEMORY_ROLE = "developer";
const MEMORY_POSITION = 1;

/** The last user message with string content; LLM-specific messages are not plain objects. */
function latestUserText(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isPlainObject(message) && message.role === "user" && typeof message.content === "string") {
      return message.content;
    }
  }
  return null;
}

export class Mem0MemoryProvider implements MemoryProvider {
  readonly #engine: MemoryEngine;
  readonly #scope: MemoryScope;
  readonly #search: MemorySearchSettings;
  #lastQuery: string | null = null;

  constructor(engine: MemoryEngine, scope: MemoryScope, search: MemorySearchSettings) {
    this.#engine = engine;
    this.#scope = scope;
    this.#search = search;
  }

  async onContext(turn: ContextTurn): Promise<void> {
    const { context, signal } = turn;
    if (signal.aborted) throw signal.reason;
    const messages = context.getMessages();
    const latest = latestUserText(messages);
    if (!latest) return;
    const toStore = messages.filter(
      (m) => isPlainObject(m) && (m.role === "user" || m.role === "assistant"),
    );
    await this.#enhance(turn, latest);
    turn.spawn("mem0_store", () => this.#store(toStore));
  }

  errorMessage(error: unknown): string {
    return `Error processing with Mem0: ${errorText(error)}`;
  }

  async #enhance(turn: ContextTurn, query: string): Promise<void> {
    if (this.#lastQuery === query) return;
    this.#lastQuery = query;
    // The engine's search can't be cancelled: an interrupted turn just stops waiting for it.
    const memories = await raceAbort(this.#retrieve(query, turn.signal), turn.signal);
    if (turn.signal.aborted) throw turn.signal.reason;
    if (!memories.length) return;
    let text = MEMORY_PREFIX;
    memories.forEach((memory, i) => {
      text += `${i + 1}. ${pyStr(memory.memory ?? "")}\n\n`;
    });
    // The block stays in the shared context, so each turn that recalls something adds another,
    // newest first right after the first message. OpenRouter receives them as `user` messages.
    const messages = turn.context.getMessages();
    messages.splice(Math.max(0, Math.min(MEMORY_POSITION, messages.length)), 0, {
      role: MEMORY_ROLE,
      content: text,
    });
    turn.context.setMessages(messages);
    logger.debug(`Enhanced context with ${memories.length} memories`);
  }

  async #retrieve(query: string, signal: AbortSignal): Promise<MemoryItem[]> {
    try {
      logger.debug(`Retrieving memories for query: ${query}`);
      const results = await this.#engine.search(query, {
        filters: this.#scope,
        topK: this.#search.searchLimit,
        threshold: this.#search.searchThreshold,
      });
      if (signal.aborted) return [];
      logger.debug(`Retrieved ${results.length} memories from Mem0`);
      return results;
    } catch (error) {
      if (!signal.aborted) logger.error(`Error retrieving memories from Mem0: ${errorText(error)}`);
      return [];
    }
  }

  /**
   * Pipecat records `{"role": "assistant", "tool_calls": [...]}` with no `content` on every tool
   * call, and mem0 rejects a whole batch over one such message. It stays in the cumulative context,
   * so the filter runs on every store; a batch that filters down to nothing skips the call.
   */
  async #store(messages: readonly unknown[]): Promise<void> {
    const sanitized = messages.filter(
      (m): m is ConversationMessage =>
        isPlainObject(m) &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        pyStrip(m.content) !== "",
    );
    const dropped = messages.length - sanitized.length;
    if (!sanitized.length) {
      if (dropped) {
        logger.debug(
          `Mem0: skipping store — all ${dropped} messages had non-string or empty content (likely tool_calls)`,
        );
      }
      return;
    }
    if (dropped) {
      logger.debug(
        `Mem0: dropped ${dropped} non-string-content message(s) before storing ${sanitized.length} valid one(s)`,
      );
    }
    try {
      logger.debug(`Storing ${sanitized.length} messages in Mem0`);
      await this.#engine.add(sanitized, { scope: this.#scope, metadata: { platform: "pipecat" } });
    } catch (error) {
      logger.error(`Error storing messages in Mem0: ${errorText(error)}`);
    }
  }

  /**
   * Every memory in scope, newest first. Pipecat's own version returns mem0's default 20 in
   * scroll order, which is by random point id, so the greeting would quote the same few memories
   * every session however many are stored since.
   */
  async newestFirst(): Promise<MemoryItem[]> {
    return sortNewestFirst(await this.#engine.getAll({ filters: this.#scope, topK: LIST_LIMIT }));
  }
}

/** createMemoryProvider over an explicit engine cache. */
export async function openMemoryProvider(
  options: { readonly userId: string },
  engines: SharedEngine,
): Promise<MemoryProvider> {
  const config = buildMemoryConfig();
  const search = memorySearchSettingsFromEnv();
  // The collection setup reruns at every session start, so a dropped collection comes back and a
  // Qdrant outage then costs only that session its memory.
  const { engine, fresh } = await engines.get(config);
  if (!fresh) await engine.ensureCollection();
  const agentId = envOptional("MEM0_AGENT_ID") ?? null;
  const runId = envOptional("MEM0_RUN_ID") ?? null;
  logger.info(
    `Initialized Mem0MemoryService with user_id=${pyRepr(options.userId)}, ` +
      `agent_id=${pyRepr(agentId)}, run_id=${pyRepr(runId)}`,
  );
  return new Mem0MemoryProvider(engine, { userId: options.userId, agentId, runId }, search);
}
