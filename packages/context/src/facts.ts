// RAG over hand-compiled fan facts about the streamer, one line each. Unlike the archive's blocks,
// a facts block is never replaced: one accumulates per enhanced turn, as in Python.
import { cpLen, errorText, logger, pyRepr, pyStr, pyStrip, pyTruthy } from "@eidolon/config";
import type { ContextProvider, ContextTurn, ConversationContext } from "@eidolon/core";
import {
  buildQueryText,
  openPersonaFactsRetriever,
  personaFactsSearchParams,
  type Retriever,
  type SearchRow,
} from "@eidolon/retrieval";
import { pyRstrip } from "./compat.ts";
import { decisionOf, type GateDecision, unlessSkipped } from "./gate.ts";
import { OVERVIEW_FRAME_KEY } from "./recall.ts";

export interface PersonaFactsParams {
  readonly topK: number;
  readonly candidates: number;
  readonly minQueryChars: number;
  readonly maxUserTurns: number;
  readonly datePrefilter: boolean;
  /**
   * The source facts are written in third person, so the prompt has to tell the LLM these are
   * its own past statements.
   */
  readonly systemPrompt: string;
  readonly position: number;
}

export function personaFactsParams(): PersonaFactsParams {
  return {
    ...personaFactsSearchParams(),
    minQueryChars: 4,
    maxUserTurns: 3,
    datePrefilter: true,
    systemPrompt:
      "你过去在直播里说过 / 设定过的相关事实（用来 ground 你的回复，不要照念，也不要把日期念出来）：\n\n",
    position: 2,
  };
}

export function formatFacts(facts: readonly SearchRow[], prefix: string): string {
  const lines = [prefix];
  for (const fact of facts) {
    const text = pyTruthy(fact.text) ? pyStrip(pyStr(fact.text)) : "";
    if (!text) continue;
    const date = pyTruthy(fact.date) ? pyStr(fact.date) : "";
    lines.push(date ? `- [${date}] ${text}` : `- ${text}`);
  }
  return `${pyRstrip(lines.join("\n"))}\n`;
}

export interface PersonaFactsOptions {
  readonly retriever: Retriever;
}

/** The persona-facts RAG provider. */
export class PersonaFacts implements ContextProvider {
  /** Rejects when the facts index can't be opened; runtime logs `Persona facts disabled: ${e}`. */
  static async open(options: { dbPath: string }): Promise<PersonaFacts> {
    const retriever = await openPersonaFactsRetriever(options.dbPath);
    const facts = new PersonaFacts({ retriever });
    if (retriever.hasTable) {
      const { candidates, topK, datePrefilter } = facts.params;
      logger.info(
        `PersonaFactsService initialized with ${await retriever.rowCount()} facts ` +
          `(candidates=${candidates}, top_k=${topK}, date_prefilter=${pyRepr(datePrefilter)})`,
      );
    }
    return facts;
  }

  readonly params: PersonaFactsParams;
  /** The last searched query; a new turn whose query text repeats it searches nothing. */
  lastQuery: string | null = null;
  readonly #retriever: Retriever;

  constructor(options: PersonaFactsOptions) {
    this.params = personaFactsParams();
    this.#retriever = options.retriever;
  }

  async onContext(turn: ContextTurn): Promise<void> {
    const { context, metadata, signal } = turn;
    signal.throwIfAborted();
    const query = buildQueryText(context.getMessages(), {
      maxUserTurns: this.params.maxUserTurns,
    });
    if (pyTruthy(metadata[OVERVIEW_FRAME_KEY])) {
      this.lastQuery = query;
      return;
    }
    if (query && cpLen(pyStrip(query)) >= this.params.minQueryChars) {
      await this.enhance(context, query, decisionOf(metadata), signal);
    }
  }

  errorMessage(error: unknown): string {
    return `PersonaFactsService error: ${errorText(error)}`;
  }

  async enhance(
    context: ConversationContext,
    query: string,
    decision: GateDecision | null = null,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.lastQuery === query) return;
    // Set before the search, so a turn the gate skipped still counts as searched.
    this.lastQuery = query;
    const { candidates, topK, datePrefilter } = this.params;
    const facts = await unlessSkipped(
      decision,
      (search) =>
        this.#retriever.search(query, { candidates, topK, datePrefilter, signal: search }),
      signal,
    );
    signal?.throwIfAborted();
    if (facts.length === 0) return;
    const content = formatFacts(facts, this.params.systemPrompt);
    const messages = [...context.getMessages()];
    const position = Math.max(0, Math.min(this.params.position, messages.length));
    messages.splice(position, 0, { role: "system", content });
    context.setMessages(messages);
    logger.info(
      `Persona facts injected ${facts.length} facts at position ${position} ` +
        `(${cpLen(content)} chars)`,
    );
  }
}
