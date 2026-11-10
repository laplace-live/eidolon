// Who answers each line of a group chat. One Decisions request, on the gate's role, asks of every
// persona who didn't write the line whether it is addressed to her and whether it touches what she
// cares about, and once whether it invites a reply; the rules below turn those answers into
// replies. Nobody speaks before it answers, so it gives up after DIRECTOR_TIMEOUT_SEC and falls
// back to rules that need no model.
import {
  activePersona,
  chatInterests,
  chatTalkativeness,
  logger,
  pyFixed,
  withPersona,
} from "@eidolon/config";
import { errorRepr } from "./compat.ts";
import { DecisionsClient, type DecisionsOptions, gateRoleDecisions, noulOf } from "./gate.ts";

// Bars on Jev's nouls. With these, docs/benchmarks/2026-11-10-director decides all 100 of its
// labelled lines right, and still does with any one bar moved: addressed from 0.4 to 0.63,
// interest from 0.1 to 0.43, invites from 0.17 to 0.38.
export const ADDRESSED_THRESHOLD = 0.5;
/** On interested × talkativeness. */
export const INTEREST_THRESHOLD = 0.3;
export const INVITES_THRESHOLD = 0.3;
/** Each persona-to-persona hop raises every bar by this, so chains die down on their own. */
export const HOP_STEP = 0.1;
/** Off the interest of whoever spoke the persona line before, so two can't trade the floor. */
export const JUST_SPOKE_PENALTY = 0.1;
export const MAX_REPLIES_TO_USER = 2;
// Jev answered in ~0.5 s on a warm connection and 1.3–1.4 s on a fresh TLS one
// (docs/benchmarks/2026-09-19-retrieval-gate).
export const DIRECTOR_TIMEOUT_SEC = 2;

const EARLIER_LINES = 8;
const RECENT_LINES = 10;

/** A persona as the director weighs her. */
export interface DirectorParticipant {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  /** identity.summary */
  readonly summary: string;
  /** chat.interests */
  readonly interests: readonly string[];
  /** chat.talkativeness, 0 to 1. */
  readonly talkativeness: number;
}

/** A line of the chat, as a chat event's speaker and text. */
export interface DirectorLine {
  readonly speaker: { readonly kind: "user" } | { readonly kind: "persona"; readonly id: string };
  readonly text: string;
  /** Absent means text. */
  readonly modality?: "text" | "voice" | "call";
}

export interface DirectorInput {
  /** Every persona in the chat. */
  readonly participants: readonly DirectorParticipant[];
  /** The chat's lines, oldest first; the last is the one to answer. */
  readonly lines: readonly DirectorLine[];
  /** 0 for the viewer's line, then 1, 2… for each decision after it in the chain. */
  readonly hop: number;
  /** The participants the last line @-mentions, in order (parseMentions). */
  readonly mentions?: readonly string[];
}

export interface DirectorReply {
  readonly persona: string;
  readonly mode: "text";
}

export interface DirectorDecision {
  /** Who answers, in order. */
  readonly replies: readonly DirectorReply[];
  readonly source: "single" | "mention" | "model" | "fallback";
  /** Jev's nouls by question, for calibration; empty when it wasn't asked or didn't answer. */
  readonly scores: Readonly<Record<string, number>>;
}

export interface DirectorStateLine {
  /** Her name, or "viewer". */
  readonly speaker: string;
  readonly text: string;
  readonly modality: "text" | "voice" | "call";
}

/** What Jev reads. */
export interface DirectorState {
  readonly participants: readonly {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
    readonly interests: readonly string[];
  }[];
  readonly earlier_lines: readonly DirectorStateLine[];
  readonly latest: DirectorStateLine;
  /** Each persona's lines among the last few, by name, so no one dominates. */
  readonly recent_turns: Readonly<Record<string, number>>;
}

export type DirectorQuestions = Record<string, { type: "noul"; instructions: string }>;

function latestOf(input: DirectorInput): DirectorLine {
  const latest = input.lines.at(-1);
  if (latest === undefined) throw new TypeError("the director needs a line to answer");
  return latest;
}

/** Every participant but the latest line's speaker. */
function candidatesOf(input: DirectorInput): DirectorParticipant[] {
  const { speaker } = latestOf(input);
  return input.participants.filter((p) => speaker.kind !== "persona" || p.id !== speaker.id);
}

export function directorState(input: DirectorInput): DirectorState {
  const names = new Map(input.participants.map((p) => [p.id, p.name]));
  const line = ({ speaker, text, modality }: DirectorLine): DirectorStateLine => ({
    speaker: speaker.kind === "user" ? "viewer" : (names.get(speaker.id) ?? speaker.id),
    text,
    modality: modality ?? "text",
  });
  const recent: Record<string, number> = Object.fromEntries(
    input.participants.map((p) => [p.name, 0]),
  );
  for (const { speaker } of input.lines.slice(-RECENT_LINES)) {
    const name = speaker.kind === "persona" ? names.get(speaker.id) : undefined;
    if (name !== undefined) recent[name] = (recent[name] as number) + 1;
  }
  return {
    participants: input.participants.map(({ id, name, summary, interests }) => ({
      id,
      name,
      summary,
      interests,
    })),
    earlier_lines: input.lines.slice(-(EARLIER_LINES + 1), -1).map(line),
    latest: line(latestOf(input)),
    recent_turns: recent,
  };
}

/** Per candidate, `addressed_<id>` and `interested_<id>`; then `invites_reply`. Jev reads them literally. */
export function directorQuestions(
  candidates: readonly Pick<DirectorParticipant, "id" | "name">[],
): DirectorQuestions {
  const questions: DirectorQuestions = {};
  for (const { id, name } of candidates) {
    questions[`addressed_${id}`] = {
      type: "noul",
      instructions: `Is the latest message addressed to ${name}, by name or by answering what she said?`,
    };
    questions[`interested_${id}`] = {
      type: "noul",
      instructions:
        `Is the latest message about something ${name} cares about (her interests above), ` +
        "or something she has a stake in?",
    };
  }
  questions.invites_reply = {
    type: "noul",
    instructions:
      "Does the latest message invite a reply (a question, an opinion, a tease) rather than " +
      "close the exchange?",
  };
  return questions;
}

function mentioned(input: DirectorInput, candidates: readonly DirectorParticipant[]): string[] {
  return (input.mentions ?? []).filter((id) => candidates.some((p) => p.id === id));
}

/** The persona who spoke the last persona line before the latest one. */
function spokeBefore(lines: readonly DirectorLine[]): string | undefined {
  const line = lines.slice(0, -1).findLast((l) => l.speaker.kind === "persona");
  return line?.speaker.kind === "persona" ? line.speaker.id : undefined;
}

function mostTalkative(ranked: readonly DirectorParticipant[]): DirectorParticipant {
  return ranked.reduce((best, p) => (p.talkativeness > best.talkativeness ? p : best));
}

function choose(
  input: DirectorInput,
  candidates: readonly DirectorParticipant[],
  scores: Readonly<Record<string, number>>,
): { ids: string[]; source: "mention" | "model" } {
  const toViewer = latestOf(input).speaker.kind === "user";
  const raise = toViewer ? 0 : HOP_STEP * input.hop;
  const cap = toViewer ? MAX_REPLIES_TO_USER : 1;
  if (!toViewer && (scores.invites_reply as number) < INVITES_THRESHOLD + raise) {
    return { ids: [], source: "model" };
  }
  const named = mentioned(input, candidates);
  const addressed = candidates
    .map((p) => ({ id: p.id, score: scores[`addressed_${p.id}`] as number }))
    .filter(({ score }) => score >= ADDRESSED_THRESHOLD + raise)
    .sort((a, b) => b.score - a.score)
    .map(({ id }) => id);
  const first = [...new Set([...named, ...addressed])];
  if (first.length > 0) {
    return { ids: first.slice(0, cap), source: named.length > 0 ? "mention" : "model" };
  }
  const last = spokeBefore(input.lines);
  const ranked = candidates
    .map((p) => ({
      p,
      score:
        (scores[`interested_${p.id}`] as number) * p.talkativeness -
        (p.id === last ? JUST_SPOKE_PENALTY : 0),
    }))
    .sort((a, b) => b.score - a.score || b.p.talkativeness - a.p.talkativeness);
  const keen = ranked.filter(({ score }) => score >= INTEREST_THRESHOLD + raise);
  if (keen.length > 0) return { ids: keen.slice(0, cap).map(({ p }) => p.id), source: "model" };
  // The viewer is never left unanswered, so the keenest answers below the bar; the most talkative
  // instead sent the benchmark's cooking question to the idol (interest 0.08) over the cook (0.94).
  // A persona's line may go unanswered.
  return { ids: toViewer ? ranked.slice(0, 1).map(({ p }) => p.id) : [], source: "model" };
}

/** Mentions, else the participants the line names, else, for the viewer's line, the most talkative. */
function fallback(input: DirectorInput, candidates: readonly DirectorParticipant[]): string[] {
  const latest = latestOf(input);
  const toViewer = latest.speaker.kind === "user";
  const cap = toViewer ? MAX_REPLIES_TO_USER : 1;
  const named = mentioned(input, candidates);
  if (named.length > 0) return named.slice(0, cap);
  const text = latest.text.toLowerCase();
  const found = candidates
    .map((p) => {
      const at = [p.name, p.shortName]
        .filter((name) => name !== "")
        .map((name) => text.indexOf(name.toLowerCase()))
        .filter((index) => index >= 0);
      return { id: p.id, at: at.length > 0 ? Math.min(...at) : -1 };
    })
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at);
  if (found.length > 0) return found.slice(0, cap).map(({ id }) => id);
  return toViewer ? [mostTalkative(candidates).id] : [];
}

function decision(
  ids: readonly string[],
  source: DirectorDecision["source"],
  scores: Readonly<Record<string, number>> = {},
): DirectorDecision {
  return { replies: ids.map((persona) => ({ persona, mode: "text" })), source, scores };
}

/** Decides who answers each line of a chat; never rejects but for its caller's abort. */
export class Director {
  readonly #client: DecisionsClient | null;

  /** Without `options`, every group decision falls back to the rules. */
  constructor(options: DecisionsOptions | null) {
    this.#client = options === null ? null : new DecisionsClient(options, DIRECTOR_TIMEOUT_SEC);
  }

  /** One request for a chat of two or more personas; `signal` rejects it with its reason. */
  async decide(input: DirectorInput, signal?: AbortSignal): Promise<DirectorDecision> {
    signal?.throwIfAborted();
    const candidates = candidatesOf(input);
    if (input.participants.length < 2) {
      return decision(
        candidates.slice(0, 1).map(({ id }) => id),
        "single",
      );
    }
    const started = performance.now();
    const names = (ids: readonly string[]) =>
      ids.length === 0
        ? "no one"
        : ids.map((id) => candidates.find((p) => p.id === id)?.name ?? id).join(", ");
    const fellBack = () => {
      const ids = fallback(input, candidates);
      logger.info(`Director: ${names(ids)} (fallback, hop ${input.hop})`);
      return decision(ids, "fallback");
    };
    if (this.#client === null) return fellBack();
    const questions = directorQuestions(candidates);
    let scores: Record<string, number>;
    try {
      const body = await this.#client.ask(directorState(input), questions, signal);
      scores = Object.fromEntries(Object.keys(questions).map((key) => [key, noulOf(body, key)]));
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      logger.warning(`Director fell back to rules: ${errorRepr(error)}`);
      return fellBack();
    }
    const { ids, source } = choose(input, candidates, scores);
    logger.info(
      `Director: ${names(ids)} (${source}, hop ${input.hop}, ` +
        `${pyFixed(performance.now() - started, 0)} ms)`,
    );
    return decision(ids, source, scores);
  }
}

/** Persona `id` as the director weighs her, from her settings. The caller validates the id. */
export function directorParticipant(id: string): DirectorParticipant {
  return withPersona(id, () => {
    const { name, shortName, summary } = activePersona().identity;
    return {
      id,
      name,
      shortName,
      summary,
      interests: chatInterests(),
      talkativeness: chatTalkativeness(),
    };
  });
}

/** The director on the active persona's gate role; without its key, it follows the rules alone. */
export function directorFromEnv(): Director {
  const options = gateRoleDecisions((error) =>
    logger.warning(`Director's decision model off: ${error.message}`),
  );
  if (options === null) logger.info("Director has no decision model: group chats follow rules");
  return new Director(options);
}
