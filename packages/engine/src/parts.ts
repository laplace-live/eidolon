// What a persona brings to a chat turn, built as a call builds it (runtime's session.ts): Mem0, the
// stream archive, persona facts, the retrieval gate, take_selfie and recall_streams, and for a
// voice message her voice-style tool. These are kept per chat and persona until the settings
// change, because the providers remember the conversation they serve (the turn they last searched,
// the archive's recall scope), and what failed to open is tried again later. The system
// instruction is rebuilt every turn, because it carries the clock.
import { stat } from "node:fs/promises";
import type { UserContext } from "@eidolon/access";
import type { ChatEvent, ParticipantId } from "@eidolon/chat";
import { errorText, logger, pyRepr, settingsGeneration, withPersona } from "@eidolon/config";
import {
  buildSystemInstruction,
  PersonaFacts,
  RECALL_HINT,
  RECALL_PREFIX,
  RECALL_TOOL_NAME,
  retrievalGateFromEnv,
  StreamArchive,
} from "@eidolon/context";
import type { ContextProvider, LlmTool, TurnGate } from "@eidolon/core";
import { createMemoryProvider, isMemoryConfigured, MEM0_LABEL } from "@eidolon/memory";
import { ingestHint, PERSONA_FACTS, resolveDbPath, STREAM_ARCHIVE } from "@eidolon/retrieval";
import {
  createSelfieTool,
  createVoiceTool,
  loadVoiceStyles,
  selfiePromptHint,
  type VoiceStyles,
  voicePromptHint,
} from "@eidolon/tools";
import type { EngineDeps, PartsOptions, PersonaParts } from "./types.ts";

/** The stream archive: a context provider that may also offer recall_streams. */
export interface ArchiveProvider extends ContextProvider {
  recallTool(): Promise<LlmTool | null>;
  resumeSelection(broadcastIds: readonly string[]): Promise<void>;
}

/** A viewer's Mem0 provider. */
export interface MemoryProvider extends ContextProvider {
  newestFirst(): Promise<readonly { readonly memory?: unknown }[]>;
}

/** Everything parts take from the other packages, so tests can stand in for any of it. */
export interface PartsDeps {
  createSelfieTool(): LlmTool | null;
  selfiePromptHint(): string;
  loadVoiceStyles(): VoiceStyles;
  createVoiceTool(styles: VoiceStyles): LlmTool | null;
  voicePromptHint(styles: VoiceStyles): string;
  buildSystemInstruction(input: {
    viewer: UserContext;
    voiceHint: string;
    selfieHint: string;
    participants?: readonly string[];
    realtime?: boolean;
  }): Promise<string>;
  dbPath(): string;
  dbPathExists(path: string): Promise<boolean>;
  openArchive(dbPath: string): Promise<ArchiveProvider>;
  openFacts(dbPath: string): Promise<ContextProvider>;
  retrievalGateFromEnv(): TurnGate | null;
  isMemoryConfigured(): boolean;
  createMemoryProvider(options: { userId: string }): Promise<MemoryProvider>;
  settingsGeneration(): number;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export const productionPartsDeps: PartsDeps = {
  createSelfieTool: () => createSelfieTool(),
  selfiePromptHint: () => selfiePromptHint(),
  loadVoiceStyles: () => loadVoiceStyles(),
  createVoiceTool,
  voicePromptHint,
  buildSystemInstruction,
  dbPath: resolveDbPath,
  dbPathExists: pathExists,
  openArchive: (dbPath) => StreamArchive.open({ dbPath }),
  openFacts: (dbPath) => PersonaFacts.open({ dbPath }),
  retrievalGateFromEnv,
  isMemoryConfigured,
  createMemoryProvider,
  settingsGeneration,
};

/**
 * Shares one open between the turns that wait for it. A null result is opened again by the first
 * turn `retryMs` after it.
 */
class Retried<T> {
  readonly #retryMs: number;
  #pending: Promise<T | null> | null = null;
  #failedAt = Number.NEGATIVE_INFINITY;

  constructor(retryMs = 0) {
    this.#retryMs = retryMs;
  }

  async get(open: () => Promise<T | null>): Promise<T | null> {
    if (this.#pending === null && Date.now() - this.#failedAt < this.#retryMs) return null;
    this.#pending ??= open();
    const pending = this.#pending;
    const value = await pending;
    if (value === null && this.#pending === pending) {
      this.#pending = null;
      this.#failedAt = Date.now();
    }
    return value;
  }
}

/**
 * The broadcasts `persona`'s last recall_streams call in `events` returned, which an archive
 * opened on the chat takes up as its selection. Null when no call returned any, or when a recall
 * block came after it: the archive's own recall may have moved the selection, which the log
 * doesn't record.
 */
export function lastSelection(
  events: readonly ChatEvent[],
  persona: ParticipantId,
): readonly string[] | null {
  const calls = new Set<string>();
  let selected: readonly string[] | null = null;
  for (const event of events) {
    if (event.type === "tool-call" && event.persona === persona) {
      if (event.name === RECALL_TOOL_NAME) calls.add(`${event.turn}/${event.callId}`);
    } else if (event.type === "tool-result" && event.persona === persona) {
      const ids = event.result.broadcast_ids;
      // A failed call left the selection as it was.
      if (calls.has(`${event.turn}/${event.callId}`) && Array.isArray(ids)) {
        selected = ids.length > 0 ? ids.filter((id) => typeof id === "string") : null;
      }
    } else if (event.type === "context" && event.persona === persona) {
      const recall = event.content.startsWith(RECALL_PREFIX);
      if (recall && event.content !== RECALL_PREFIX + RECALL_HINT) selected = null;
    }
  }
  return selected;
}

/** How many chats' parts are kept; the one used longest ago goes first. */
const KEPT_CHATS = 32;

/**
 * Opening Mem0 reaches Qdrant, which can take its whole timeout when the host is down, and Qdrant's
 * client warns on the console each time, so a chat tries again only this often.
 */
const MEMORY_RETRY_MS = 60_000;

/** One persona's parts in one chat, for one settings generation. */
class Pieces {
  readonly generation: number;
  readonly #persona: ParticipantId;
  readonly #deps: PartsDeps;
  readonly #archive = new Retried<ArchiveProvider>();
  readonly #facts = new Retried<ContextProvider>();
  readonly #memories = new Map<string, Retried<MemoryProvider>>();
  /** What is off and already said so: a chat logs it once, not every turn. */
  readonly #missing = new Set<string>();
  #selfie: { readonly tool: LlmTool | null; readonly hint: string } | null = null;
  /** Her voice-style tool and its hint, read the first time a voice message needs them. */
  #voice: { readonly tool: LlmTool | null; readonly hint: string } | null = null;
  #recall: LlmTool | null = null;
  #gate: TurnGate | null | undefined;

  constructor(generation: number, persona: ParticipantId, deps: PartsDeps) {
    this.generation = generation;
    this.#persona = persona;
    this.#deps = deps;
  }

  async parts(
    viewer: UserContext,
    events: readonly ChatEvent[],
    { others = [], voice: spoken = false, realtime = false }: PartsOptions,
  ): Promise<PersonaParts> {
    const deps = this.#deps;
    this.#selfie ??= (() => {
      const tool = deps.createSelfieTool();
      return { tool, hint: tool ? deps.selfiePromptHint() : "" };
    })();
    if (spoken) {
      this.#voice ??= (() => {
        const styles = deps.loadVoiceStyles();
        const tool = deps.createVoiceTool(styles);
        return { tool, hint: tool ? deps.voicePromptHint(styles) : "" };
      })();
    }
    const voice = spoken ? this.#voice : null;
    const dbPath = deps.dbPath();
    const [archive, memory, facts, systemInstruction] = await Promise.all([
      this.#archive.get(async () => {
        const archive = await this.#optional(
          "Stream archive",
          STREAM_ARCHIVE.ingestCommand,
          dbPath,
          deps.openArchive,
        );
        if (archive !== null) await this.#resume(archive, events);
        return archive;
      }),
      this.#memory(viewer),
      this.#facts.get(() =>
        this.#optional("Persona facts", PERSONA_FACTS.ingestCommand, dbPath, deps.openFacts),
      ),
      deps.buildSystemInstruction({
        viewer,
        voiceHint: voice?.hint ?? "",
        selfieHint: this.#selfie.hint,
        ...(others.length > 0 ? { participants: others } : {}),
        ...(realtime ? { realtime: true } : {}),
      }),
    ]);
    if (archive !== null) this.#recall ??= await archive.recallTool();
    if (this.#gate === undefined && (archive !== null || facts !== null)) {
      this.#gate = deps.retrievalGateFromEnv();
    }
    const providers: { label: string; provider: ContextProvider }[] = [];
    if (memory) providers.push({ label: MEM0_LABEL, provider: memory });
    if (archive) providers.push({ label: "StreamArchiveService", provider: archive });
    if (facts) providers.push({ label: "PersonaFactsService", provider: facts });
    return {
      systemInstruction,
      providers,
      gate: this.#gate ?? null,
      // A call's order: voice, selfie, recall.
      tools: [voice?.tool ?? null, this.#selfie.tool, this.#recall].filter(
        (tool): tool is LlmTool => tool !== null,
      ),
      memories: async () => (memory === null ? [] : memory.newestFirst()),
    };
  }

  async #resume(archive: ArchiveProvider, events: readonly ChatEvent[]): Promise<void> {
    const selected = lastSelection(events, this.#persona);
    if (selected === null) return;
    try {
      await archive.resumeSelection(selected);
    } catch (e) {
      logger.warning(`Stream archive: the chat's last recall selection is lost: ${errorText(e)}`);
    }
  }

  /** runtime's optionalProvider, logging the same lines. */
  async #optional<T>(
    label: string,
    ingestCommand: string,
    dbPath: string,
    open: (dbPath: string) => Promise<T>,
  ): Promise<T | null> {
    if (!(await this.#deps.dbPathExists(dbPath))) {
      this.#once(
        label,
        `${label} disabled: no LanceDB index at ${dbPath}. Run \`${ingestHint(ingestCommand)}\` to build it.`,
      );
      return null;
    }
    try {
      return await open(dbPath);
    } catch (e) {
      this.#once(`${label} failed`, `${label} disabled: ${errorText(e)}`, "WARNING");
      return null;
    }
  }

  #once(key: string, message: string, level: "INFO" | "WARNING" = "INFO"): void {
    if (this.#missing.has(key)) return;
    this.#missing.add(key);
    logger.log(level, message);
  }

  /** runtime's sessionMemory: an anonymous viewer or an unset vector store skips Mem0. */
  async #memory(viewer: UserContext): Promise<MemoryProvider | null> {
    if (!viewer.isLoggedIn) {
      this.#once("anonymous", "Mem0 skipped: anonymous viewer");
      return null;
    }
    const deps = this.#deps;
    if (!deps.isMemoryConfigured()) {
      this.#once("memory", "Mem0 skipped: MEM0_QDRANT_HOST is unset, so there is no vector store");
      return null;
    }
    const userId = String(viewer.mid);
    let slot = this.#memories.get(userId);
    if (slot === undefined) {
      slot = new Retried<MemoryProvider>(MEMORY_RETRY_MS);
      this.#memories.set(userId, slot);
    }
    return slot.get(async () => {
      try {
        const memory = await deps.createMemoryProvider({ userId });
        logger.info(
          `Mem0 long-term memory enabled for user_id=${viewer.mid} (${pyRepr(viewer.uname)})`,
        );
        return memory;
      } catch (e) {
        // Constructing the engine reaches Qdrant, so an unreachable vector store surfaces here.
        this.#once(
          `memory ${userId}`,
          `Mem0 unavailable, continuing without memory: ${errorText(e)}`,
          "WARNING",
        );
        return null;
      }
    });
  }
}

/** EngineDeps.parts over the cache of each chat's Pieces. */
export function personaParts(deps: PartsDeps = productionPartsDeps): EngineDeps["parts"] {
  const cache = new Map<string, Pieces>();
  return (persona, viewer, chat, options = {}) =>
    withPersona(persona, () => {
      const generation = deps.settingsGeneration();
      const key = `${options.chatKey ?? chat.header.id}/${persona}`;
      let pieces = cache.get(key);
      if (pieces === undefined || pieces.generation !== generation) {
        pieces = new Pieces(generation, persona, deps);
      }
      cache.delete(key);
      cache.set(key, pieces);
      for (const old of cache.keys()) {
        if (cache.size <= KEPT_CHATS) break;
        cache.delete(old);
      }
      return pieces.parts(viewer, chat.events, options);
    });
}
