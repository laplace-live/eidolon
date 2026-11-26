// Jev decides once per user turn whether the Zvec knowledge tiers search at all. Both RAG providers
// race their search against that decision through unlessSkipped, so it may cancel a search but
// never delays one.
import {
  activePersona,
  envFlag,
  logger,
  pyFixed,
  pyRepr,
  pyStrip,
  raceAbort,
} from "@eidolon/config";
import type { FrameMetadata } from "@eidolon/core";
import { type DecisionAnswers, type DecisionModel, gateDecisionModel } from "@eidolon/providers";
import { errorRepr } from "./compat.ts";
import { isMessage, sameTurn, type TurnKey, turnKeyOf } from "./messages.ts";

export const GATE_FRAME_KEY = "retrieval_gate";
export const DEFAULT_GATE_MODEL = "~typesafe/jev-latest";
export const GATE_TIMEOUT_SEC = 10;

// Set on jev-1.13 against 185 labeled turns: the lowest of the 93 that needed
// recall scored 0.58, and repeat calls on one input moved by at most 0.05.
// docs/benchmarks/2026-09-19-retrieval-gate
export const GATE_THRESHOLD = 0.3;

// The persona's identity.summary, which Jev reads as who "the streamer" is. Dropping 奶绿's cost 2
// of 93 recall turns; dropping it with her pack's "her flower shop" question cost 5, every one a
// question about her cat or her shop.
export function gateStreamer(): string {
  return activePersona().identity.summary;
}

// Jev reads each question literally, so each asks one thing and any one
// clearing the threshold means retrieve. A persona's knowledge.gate.questions replace these texts.
export const GATE_QUESTIONS = {
  about_her: {
    type: "noul",
    instructions:
      "Is the viewer's latest message asking about the streamer herself — her " +
      "preferences, opinions, habits, abilities, body, family, pets, friends, " +
      "relationships, or backstory?",
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

export type GateQuestions = Record<
  keyof typeof GATE_QUESTIONS,
  { type: "noul"; instructions: string }
>;

/** GATE_QUESTIONS with the active persona's texts in place; keys and order never change. */
export function gateQuestions(): GateQuestions {
  const overrides = activePersona().gateQuestions;
  const questions = {} as GateQuestions;
  for (const [key, question] of Object.entries(GATE_QUESTIONS)) {
    const text = Object.hasOwn(overrides, key) ? overrides[key] : question.instructions;
    questions[key as keyof GateQuestions] = { type: question.type, instructions: text as string };
  }
  return questions;
}

// Asked in the same request, outside the skip score: whether the viewer asks when, or how often,
// she did something, which only the catalog's timeline answers. On jev-1.14 all 30 labeled timeline
// turns scored 0.72 or more and all 33 others 0.60 or less, and asking them moved the gate's own
// scores by at most 0.05. docs/benchmarks/2026-11-07-timeline-question
export const TIMELINE_QUESTIONS = {
  last_time: {
    type: "noul",
    instructions:
      "Does the viewer's latest message ask when the streamer last did, played, sang, or " +
      "talked about a specific thing, or how long ago that was?",
  },
  first_time: {
    type: "noul",
    instructions:
      "Does the viewer's latest message ask when the streamer did something for the first " +
      "time, such as when she first played, sang, or talked about it?",
  },
  how_often: {
    type: "noul",
    instructions:
      "Does the viewer's latest message ask how many times or how often the streamer has done " +
      "something in the past?",
  },
} as const;

export const TIMELINE_THRESHOLD = 0.7;

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

/**
 * What Jev sees: the latest user line and the turns just before it. What she said before her
 * calls, their messages' content, joins her next line into one streamer turn when no user line
 * comes between, so a recall follow-up keeps the viewer line before it.
 */
export function gateState(messages: readonly unknown[]): GateState | null {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  const push = (role: "user" | "assistant", content: string): void => {
    const text = pyStrip(content);
    if (text) turns.push({ role, text });
  };
  let said = "";
  for (const message of messages) {
    if (!isMessage(message) || typeof message.content !== "string") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      said += message.content;
    } else if (message.role === "assistant") {
      push("assistant", said + message.content);
      said = "";
    } else {
      if (said !== "") push("assistant", said);
      said = "";
      push("user", message.content);
    }
  }
  if (said !== "") push("assistant", said);
  const latest = turns.findLastIndex((turn) => turn.role === "user");
  if (latest < 0) return null;
  return {
    streamer: gateStreamer(),
    earlier_turns: turns.slice(Math.max(0, latest - EARLIER_TURNS), latest).map((turn) => ({
      speaker: turn.role === "user" ? "viewer" : "streamer",
      text: turn.text,
    })),
    viewer_latest_message: (turns[latest] as { text: string }).text,
  };
}

/** Jev's answers for one turn. */
export interface GateVerdict {
  /** Whether the Zvec tiers search at all. */
  readonly retrieve: boolean;
  /** Whether the viewer asks when, or how often, the streamer did something. */
  readonly timeline: boolean;
}

const FAIL_OPEN: GateVerdict = Object.freeze({ retrieve: true, timeline: false });

/** One turn's verdict, readable synchronously once settled. Never rejects. */
export class GateDecision {
  #done = false;
  #verdict: GateVerdict | undefined;
  /** Resolves (never rejects) once settled; every getter is current by then. */
  readonly whenSettled: Promise<void>;

  private constructor(pending: PromiseLike<GateVerdict | undefined> | null, verdict?: GateVerdict) {
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

  /** A rejection settles as undefined: retrieve. */
  static of(verdict: PromiseLike<GateVerdict | undefined>): GateDecision {
    return new GateDecision(verdict);
  }

  static settled(verdict: GateVerdict | undefined): GateDecision {
    return new GateDecision(null, verdict);
  }

  #settle(verdict: GateVerdict | undefined): void {
    this.#verdict = verdict;
    this.#done = true;
  }

  get done(): boolean {
    return this.#done;
  }

  // A failed decision settles undefined, as Pipecat's task wrapper returned None for one, so
  // only an explicit `retrieve: false` skips.
  get saidSkip(): boolean {
    return this.#verdict?.retrieve === false;
  }

  get asksTimeline(): boolean {
    return this.#verdict?.timeline === true;
  }

  /** The verdict once settled, or undefined for a failed decision. */
  async value(): Promise<GateVerdict | undefined> {
    await this.whenSettled;
    return this.#verdict;
  }
}

/** Attaches one Jev decision per user turn to every context frame of that turn. */
export class RetrievalGate {
  readonly model: string;
  readonly #decisions: DecisionModel;
  #turn: TurnKey | null = null;
  #turnId: string | undefined;
  #decision: GateDecision | null = null;

  constructor(decisions: DecisionModel) {
    this.#decisions = decisions;
    this.model = decisions.model;
  }

  /** One POST; any failure retrieves without a timeline (fail open). A null state asks nothing. */
  async decide(state: GateState | null): Promise<GateVerdict> {
    if (state === null) return FAIL_OPEN;
    const started = performance.now();
    let answers: DecisionAnswers;
    let score: number;
    try {
      answers = await this.#decisions.decide(state, { ...gateQuestions(), ...TIMELINE_QUESTIONS });
      score = highest(answers, Object.keys(GATE_QUESTIONS));
    } catch (error) {
      logger.warning(`Retrieval gate failed open: ${errorRepr(error)}`);
      return FAIL_OPEN;
    }
    // A bad timeline answer only costs the timeline, never the skip.
    let timelineScore = 0;
    try {
      timelineScore = highest(answers, Object.keys(TIMELINE_QUESTIONS));
    } catch (error) {
      logger.warning(`Retrieval gate's timeline answer unreadable: ${errorRepr(error)}`);
    }
    const verdict = {
      retrieve: score >= GATE_THRESHOLD,
      timeline: timelineScore >= TIMELINE_THRESHOLD,
    };
    logger.info(
      `Retrieval gate: ${verdict.retrieve ? "retrieve" : "skip"}` +
        `${verdict.timeline ? " + timeline" : ""} ` +
        `query=${pyRepr(state.viewer_latest_message)} (score=${pyFixed(score, 2)}, ` +
        `timeline=${pyFixed(timelineScore, 2)}, ${pyFixed(performance.now() - started, 0)} ms)`,
    );
    return verdict;
  }

  /**
   * This turn's decision: started on a new user turn, the same object for every frame of it.
   * It is never tied to a frame's signal, since it outlives that frame's processing. A new
   * `turnId` is a new turn, even over the same messages.
   */
  forTurn(messages: readonly unknown[], turnId?: string): GateDecision {
    const turn = turnKeyOf(messages);
    if (this.#decision === null || !sameTurn(this.#turn, turn) || this.#turnId !== turnId) {
      this.#turn = turn;
      this.#turnId = turnId;
      this.#decision = GateDecision.of(this.decide(gateState(messages)));
    }
    return this.#decision;
  }

  /** Starts this turn's decision without awaiting it and stores it at `metadata[GATE_FRAME_KEY]`. */
  attach(messages: readonly unknown[], metadata: FrameMetadata, turn?: string): void {
    metadata[GATE_FRAME_KEY] = this.forTurn(messages, turn);
  }
}

/** null when the gate's key is unset, its settings name no decision model, or it is disabled. */
export function retrievalGateFromEnv(): RetrievalGate | null {
  if (!envFlag("RETRIEVAL_GATE_ENABLED", true)) {
    logger.info("RETRIEVAL_GATE_ENABLED is off — every turn searches both Zvec tiers");
    return null;
  }
  const decisions = gateDecisionModel({ timeoutSec: GATE_TIMEOUT_SEC }, (error) =>
    logger.warning(`Retrieval gate off: ${error.message}`),
  );
  if (decisions === null) return null;
  logger.info(`Retrieval gate enabled: model=${pyRepr(decisions.model)}`);
  return new RetrievalGate(decisions);
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
  signal?.throwIfAborted();
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

// Python's max() keeps the first of equal or unordered values, so a NaN noul only wins first.
function highest(answers: DecisionAnswers, names: readonly string[]): number {
  let score: number | undefined;
  for (const name of names) {
    const noul = answers.probability(name);
    if (score === undefined || noul > score) score = noul;
  }
  return score as number;
}
