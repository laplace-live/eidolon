// Jev decides once per user turn whether the LanceDB tiers search at all. Both RAG providers race
// their search against that decision through unlessSkipped, so it may cancel a search but never
// delays one.
import {
  envFlag,
  envOptional,
  logger,
  openrouterHeaders,
  pyFixed,
  pyRepr,
  pyStrip,
  pyStrRepr,
} from "@eidolon/config";
import type { FrameMetadata } from "@eidolon/core";
import { raceAbort, throwIfAborted } from "./abort.ts";
import { errorRepr, pyError, pyTypeName } from "./compat.ts";
import { isMessage, sameTurn, type TurnKey, turnKeyOf } from "./messages.ts";

export const GATE_FRAME_KEY = "retrieval_gate";
export const DEFAULT_GATE_MODEL = "~typesafe/jev-latest";
export const GATE_URL = "https://openrouter.ai/api/alpha/decisions";
export const GATE_TIMEOUT_SEC = 10;

// Set on jev-1.13 against 185 labeled turns: the lowest of the 93 that needed
// recall scored 0.58, and repeat calls on one input moved by at most 0.05.
// docs/benchmarks/2026-09-19-retrieval-gate
export const GATE_THRESHOLD = 0.3;

// Dropping this line cost 2 of 93 recall turns; dropping it and "her flower
// shop" below cost 5, every one a question about her cat or her shop.
export const GATE_STREAMER =
  "明前奶绿, a Chinese VTuber who streams on Bilibili, runs a fictional flower shop " +
  "(拉普拉斯花店) whose manager is her cat 坚果, and calls her fans 奶糖花";

// Jev reads each question literally, so each asks one thing and any one
// clearing the threshold means retrieve.
export const GATE_QUESTIONS = {
  about_her: {
    type: "noul",
    instructions:
      "Is the viewer's latest message asking about the streamer herself — her " +
      "preferences, opinions, habits, abilities, body, family, pets, friends, " +
      "relationships, backstory, or her flower shop?",
  },
  her_past: {
    type: "noul",
    instructions:
      "Does the viewer's latest message ask about something the streamer said, did, " +
      "or experienced in the past, including on her past live streams?",
  },
  named_thing: {
    type: "noul",
    instructions:
      "Does the viewer's latest message ask who or what a specific named person, " +
      "character, place, group, game, song, or term is, or ask about one by name?",
  },
} as const;

// The previous user line and the reply to it, so "它几岁了？" keeps its subject.
const EARLIER_TURNS = 2;

export interface GateTurn {
  readonly speaker: "viewer" | "streamer";
  readonly text: string;
}

export interface GateState {
  readonly streamer: string;
  readonly earlier_turns: readonly GateTurn[];
  readonly viewer_latest_message: string;
}

/** What Jev sees: the latest user line and the turns just before it. */
export function gateState(messages: readonly unknown[]): GateState | null {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const message of messages) {
    if (!isMessage(message) || typeof message.content !== "string") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = pyStrip(message.content);
    if (text) turns.push({ role: message.role, text });
  }
  const latest = turns.findLastIndex((turn) => turn.role === "user");
  if (latest < 0) return null;
  return {
    streamer: GATE_STREAMER,
    earlier_turns: turns.slice(Math.max(0, latest - EARLIER_TURNS), latest).map((turn) => ({
      speaker: turn.role === "user" ? "viewer" : "streamer",
      text: turn.text,
    })),
    viewer_latest_message: (turns[latest] as { text: string }).text,
  };
}

/** One turn's verdict, readable synchronously once settled. Never rejects. */
export class GateDecision {
  #done = false;
  #verdict: boolean | undefined;
  /** Resolves (never rejects) once settled; `done` and `saidSkip` are current by then. */
  readonly whenSettled: Promise<void>;

  private constructor(pending: PromiseLike<boolean | undefined> | null, verdict?: boolean) {
    if (pending === null) {
      this.#settle(verdict);
      this.whenSettled = Promise.resolve();
    } else {
      this.whenSettled = Promise.resolve(pending).then(
        (value) => this.#settle(value),
        () => this.#settle(undefined),
      );
    }
  }

  /** A rejection or a non-boolean settles as undefined: retrieve. */
  static of(verdict: PromiseLike<boolean | undefined>): GateDecision {
    return new GateDecision(verdict);
  }

  static settled(verdict: boolean | undefined): GateDecision {
    return new GateDecision(null, verdict);
  }

  #settle(verdict: unknown): void {
    this.#verdict = typeof verdict === "boolean" ? verdict : undefined;
    this.#done = true;
  }

  get done(): boolean {
    return this.#done;
  }

  // A failed decision settles undefined, as Pipecat's task wrapper returned None for one, so
  // only an explicit false skips.
  get saidSkip(): boolean {
    return this.#done && this.#verdict === false;
  }

  /** The verdict once settled: true/false, or undefined for a failed decision. */
  async value(): Promise<boolean | undefined> {
    await this.whenSettled;
    return this.#verdict;
  }
}

export interface RetrievalGateOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly url?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutSec?: number;
}

/** Attaches one Jev decision per user turn to every context frame of that turn. */
export class RetrievalGate {
  readonly model: string;
  readonly #headers: Record<string, string>;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutSec: number;
  #turn: TurnKey | null = null;
  #decision: GateDecision | null = null;

  constructor(options: RetrievalGateOptions) {
    this.model = options.model ?? DEFAULT_GATE_MODEL;
    this.#headers = {
      ...openrouterHeaders(),
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    };
    this.#url = options.url ?? GATE_URL;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutSec = options.timeoutSec ?? GATE_TIMEOUT_SEC;
  }

  /** One POST; any failure resolves true (fail open) with a warning. A null state asks nothing. */
  async decide(state: GateState | null): Promise<boolean> {
    if (state === null) return true;
    const started = performance.now();
    let score: number;
    try {
      const post = this.#fetch;
      // The connection must outlive the gap between turns: with httpx's 5 s keep-alive, turns
      // 15-40 s apart paid a fresh TLS session each, ~1.4 s a call instead of ~0.5 s. Bun's
      // fetch pools sockets process-wide and reused an idle one after 90 s when measured.
      const response = await post(this.#url, {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify({ model: this.model, state, questions: GATE_QUESTIONS }),
        // httpx follows no redirects, so a 3xx failed open there too.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutSec * 1000),
      });
      if (!response.ok) throw statusError(response, this.#url);
      score = scoreOf(await response.json());
    } catch (error) {
      logger.warning(`Retrieval gate failed open: ${errorRepr(error)}`);
      return true;
    }
    const needed = score >= GATE_THRESHOLD;
    logger.info(
      `Retrieval gate: ${needed ? "retrieve" : "skip"} ` +
        `query=${pyRepr(state.viewer_latest_message)} (score=${pyFixed(score, 2)}, ` +
        `${pyFixed(performance.now() - started, 0)} ms)`,
    );
    return needed;
  }

  /**
   * This turn's decision: started on a new user turn, the same object for every frame of it.
   * It is never tied to a frame's signal, since it outlives that frame's processing.
   */
  forTurn(messages: readonly unknown[]): GateDecision {
    const turn = turnKeyOf(messages);
    if (this.#decision === null || !sameTurn(this.#turn, turn)) {
      this.#turn = turn;
      this.#decision = GateDecision.of(this.decide(gateState(messages)));
    }
    return this.#decision;
  }

  /** Starts this turn's decision without awaiting it and stores it at `metadata[GATE_FRAME_KEY]`. */
  attach(messages: readonly unknown[], metadata: FrameMetadata): void {
    metadata[GATE_FRAME_KEY] = this.forTurn(messages);
  }
}

/** null when OPENROUTER_API_KEY is unset or the gate is disabled. */
export function retrievalGateFromEnv(): RetrievalGate | null {
  if (!envFlag("RETRIEVAL_GATE_ENABLED", true)) {
    logger.info("RETRIEVAL_GATE_ENABLED is off — every turn searches both LanceDB tiers");
    return null;
  }
  const apiKey = envOptional("OPENROUTER_API_KEY");
  if (!apiKey) return null;
  const model = envOptional("RETRIEVAL_GATE_MODEL") ?? DEFAULT_GATE_MODEL;
  logger.info(`Retrieval gate enabled: model=${pyRepr(model)}`);
  return new RetrievalGate({ apiKey, model });
}

/** The decision a frame carries, or null when no gate ran. */
export function decisionOf(metadata: FrameMetadata): GateDecision | null {
  const decision = metadata[GATE_FRAME_KEY];
  return decision instanceof GateDecision ? decision : null;
}

/**
 * Runs `search` at once and keeps its result unless `decision` settles to exactly false before
 * it finishes, which aborts the search. A slow or failing gate never makes a turn slower than
 * searching alone.
 */
export async function unlessSkipped<T>(
  decision: GateDecision | null | undefined,
  search: (signal: AbortSignal) => Promise<T[]>,
  signal?: AbortSignal,
): Promise<T[]> {
  if (decision?.saidSkip) return [];
  throwIfAborted(signal);
  const controller = new AbortController();
  const task = search(controller.signal);
  let finished = false;
  const settled = task.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  try {
    if (decision && !decision.done) {
      await raceAbort(Promise.race([settled, decision.whenSettled]), signal);
      if (!finished && decision.saidSkip) return [];
    }
    return await raceAbort(task, signal);
  } finally {
    controller.abort();
  }
}

const FLOAT =
  /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const SPECIAL_FLOAT = /^([+-]?)(inf|infinity|nan)$/i;

// Python float(): a malformed noul must fail open, and Number(null) === 0 would read as a skip.
function pyFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const text = pyStrip(value);
    if (FLOAT.test(text)) return Number(text.replaceAll("_", ""));
    const special = SPECIAL_FLOAT.exec(text);
    if (special) {
      if (special[2]?.toLowerCase() === "nan") return Number.NaN;
      return special[1] === "-" ? -Infinity : Infinity;
    }
    throw pyError("ValueError", `could not convert string to float: ${pyStrRepr(value)}`);
  }
  throw pyError(
    "TypeError",
    `float() argument must be a string or a real number, not '${pyTypeName(value)}'`,
  );
}

function subscript(container: unknown, key: string): unknown {
  if (!isMessage(container)) {
    throw pyError("TypeError", `'${pyTypeName(container)}' object is not subscriptable`);
  }
  if (!Object.hasOwn(container, key)) throw pyError("KeyError", key);
  return container[key];
}

// Python's max() keeps the first of equal or unordered values, so a NaN noul only wins first.
function scoreOf(body: unknown): number {
  const answers = subscript(body, "answers");
  let score: number | undefined;
  for (const name of Object.keys(GATE_QUESTIONS)) {
    const noul = pyFloat(subscript(subscript(answers, name), "noul"));
    if (score === undefined || noul > score) score = noul;
  }
  return score as number;
}

function statusError(response: Response, url: string): Error {
  const status = response.status;
  const kind =
    status < 200
      ? "Informational response"
      : status < 400
        ? "Redirect response"
        : status < 500
          ? "Client error"
          : "Server error";
  const reason = response.statusText ? ` ${response.statusText}` : "";
  return pyError("HTTPStatusError", `${kind} '${status}${reason}' for url '${url}'`);
}
