// A chat's answer to the viewer's line: the director chooses who answers and whether in text or
// voice, each answers in turn, then the director is asked again about the last persona line, each
// hop against a higher bar, until no one is chosen or the chat's chain limit is reached. A chat of
// one in auto doesn't wait for the director: she writes while it weighs a voice reply.
import type { UserContext } from "@eidolon/access";
import {
  type ChatEvent,
  type ChatEventDraft,
  chainLimitOf,
  type ParticipantId,
  parseMentions,
  summarize,
} from "@eidolon/chat";
import { settingsGeneration } from "@eidolon/config";
import {
  type Director,
  type DirectorDecision,
  type DirectorLine,
  type DirectorParticipant,
  type DirectorReply,
  directorFromEnv,
  directorParticipant,
} from "@eidolon/context";
import { type UsageScope, withUsageScope } from "@eidolon/providers";
import { runTurn } from "./turn.ts";
import type {
  CallHooks,
  CallTurnOutput,
  EngineDeps,
  LateTools,
  TurnOutput,
  TurnRequest,
} from "./types.ts";
import { replyModeFor, withUnheard } from "./voice.ts";

type ChatLog = TurnRequest["chat"];

export interface OwedLine {
  /** The seq of a viewer line an answer stopped by a newer line left unanswered. */
  readonly line: number;
  /** Who its decision chose and hasn't answered yet; absent when the director hadn't decided. */
  readonly replies?: readonly DirectorReply[];
}

export interface ChatRequest {
  /** The chat as stored, through the viewer's line. */
  readonly chat: ChatLog;
  /**
   * The chat as stored now. It is read before each turn, once the caller has stored every output
   * it was given, so each turn sees what the ones before it said, numbered as stored.
   */
  read(): Promise<ChatLog>;
  /** The local viewer in the local app. */
  readonly viewer: UserContext;
  /** The seq of the viewer's line to answer. */
  readonly after: number;
  /**
   * Earlier viewer lines, oldest first, that the answer this line stopped left unanswered: their
   * replies open the first round, ahead of this line's. A chat of one ignores them, since her one
   * turn answers every line.
   */
  readonly owed?: readonly OwedLine[];
  /** Interrupts the running turn and drops every turn and hop still to come. */
  readonly signal: AbortSignal;
  /** Without it, an interruption cancels every tool, `cancelOnInterruption` or not. */
  readonly late?: LateTools;
  /** The director's and each turn's. Default: `{ source: "chat", session: <chat id> }`. */
  readonly usage?: UsageScope;
}

/** A call's answer: each persona's turn is a call's, and every reply is spoken. */
export interface CallChatRequest extends Omit<ChatRequest, "late"> {
  /** Called just before each persona's turn, for that turn alone. */
  readonly hooks: (persona: ParticipantId) => CallHooks;
}

export interface ChatDeps extends EngineDeps {
  /** Default: the active persona's gate role's, rebuilt when the settings change. */
  readonly director?: Pick<Director, "decide">;
}

type DecisionDraft = Extract<ChatEventDraft, { readonly type: "decision" }>;

/** Each turn's outputs, and a decision to store before the replies it chooses. */
export type ChatOutput = TurnOutput | DecisionDraft;
export type CallChatOutput = CallTurnOutput | DecisionDraft;

let shared: { readonly generation: number; readonly director: Director } | null = null;

function defaultDirector(): Director {
  const generation = settingsGeneration();
  if (shared?.generation !== generation) shared = { generation, director: directorFromEnv() };
  return shared.director;
}

/** The chat's lines through seq `last`, oldest first, as the director reads them. */
function linesThrough(events: readonly ChatEvent[], last: number): DirectorLine[] {
  return withUnheard(events).flatMap((event) =>
    event.type === "message" && event.text !== "" && event.seq <= last
      ? [
          {
            speaker: event.speaker,
            text: event.text,
            ...(event.modality ? { modality: event.modality } : {}),
          },
        ]
      : [],
  );
}

/** The seq of the last persona line after seq `line`, or null when no persona spoke. */
function spokenAfter(events: readonly ChatEvent[], line: number): number | null {
  const spoken = events.findLast(
    (event) =>
      event.type === "message" &&
      event.speaker.kind === "persona" &&
      event.text !== "" &&
      event.seq > line,
  );
  return spoken?.seq ?? null;
}

function decisionOutput(after: number, decision: DirectorDecision): DecisionDraft {
  return {
    type: "decision",
    after,
    replies: decision.replies,
    source: decision.source,
    ...(Object.keys(decision.scores).length > 0 ? { scores: decision.scores } : {}),
  };
}

/** Who answers, of those still `present`: each persona once, at her first place, in its mode. */
function round(
  replies: readonly (readonly DirectorReply[])[],
  present: ReadonlySet<ParticipantId>,
): DirectorReply[] {
  const once = new Map<ParticipantId, DirectorReply>();
  for (const reply of replies.flat()) {
    if (present.has(reply.persona) && !once.has(reply.persona)) once.set(reply.persona, reply);
  }
  return [...once.values()];
}

/** Her reply, or its failure, or the turn's end: what her decision must be stored before. */
function closes(output: TurnOutput): boolean {
  return (
    output.type === "ended" ||
    (output.type === "events" &&
      output.events.some((event) => event.type === "message" || event.type === "turn-failed"))
  );
}

/**
 * The only persona's turn in auto, started while `deciding` weighs voice_moment: she is spoken only
 * if it chooses voice, and it is stored just before her reply. An interruption aborts the director,
 * so her reply is text, and with nothing said, nothing is stored.
 */
async function* answerWhileDeciding(
  request: ChatRequest,
  deps: ChatDeps,
  persona: ParticipantId,
  deciding: Promise<DirectorDecision>,
): AsyncGenerator<ChatOutput> {
  const { signal } = request;
  const decided = deciding.catch(
    (): DirectorDecision => ({
      replies: [{ persona, mode: "text" }],
      source: "single",
      scores: {},
    }),
  );
  const mode = decided.then(
    ({ replies }) => replies.find((reply) => reply.persona === persona)?.mode ?? "text",
  );
  let stored = false;
  for await (const output of runTurn(
    {
      chat: await request.read(),
      persona,
      viewer: request.viewer,
      signal,
      mode,
      ...(request.late ? { late: request.late } : {}),
      ...(request.usage ? { usage: request.usage } : {}),
    },
    deps,
  )) {
    if (!stored && closes(output) && !(output.type === "ended" && signal.aborted)) {
      stored = true;
      yield decisionOutput(request.after, await decided);
    }
    yield output;
  }
}

/**
 * The chat's answer to the viewer's line at seq `request.after`, with the personas, reply modes
 * and chain limit the chat had then. The caller stores each `events` and `decision` output before
 * taking the next. A chat of one persona never chains, and asks the director only whether to
 * answer in voice, when her reply mode is auto, while she writes. An abort ends it quietly, once
 * the running turn has given what it said. In a call, every reply is spoken, so the director never
 * weighs a voice message, and each decision records its replies as text. An owed line no decision
 * covered is decided again, alongside this one, its decision yielded first.
 */
export function runChat(request: CallChatRequest, deps: ChatDeps): AsyncGenerator<CallChatOutput>;
export function runChat(request: ChatRequest, deps: ChatDeps): AsyncGenerator<ChatOutput>;
export async function* runChat(
  request: ChatRequest | CallChatRequest,
  deps: ChatDeps,
): AsyncGenerator<ChatOutput | CallChatOutput> {
  const { signal } = request;
  const { header } = request.chat;
  const director = deps.director ?? defaultDirector();
  const hooks = "hooks" in request ? request.hooks : null;
  const participants: DirectorParticipant[] = summarize(
    header,
    request.chat.events,
  ).participants.map((id) => ({
    ...directorParticipant(id),
    replyMode: hooks === null ? replyModeFor(request.chat, id, deps.speech) : "text",
  }));
  const usage = request.usage ?? { source: "chat", session: header.id };
  const turn = (chat: ChatLog, persona: ParticipantId, mode: "text" | "voice") => {
    const base = { chat, persona, viewer: request.viewer, signal, usage };
    if (hooks !== null) return runTurn({ ...base, ...hooks(persona) }, deps);
    const late = "late" in request ? request.late : undefined;
    return runTurn({ ...base, mode, ...(late ? { late } : {}) }, deps);
  };
  const decide = (lines: DirectorLine[], hop: number): Promise<DirectorDecision> =>
    withUsageScope(usage, () =>
      director.decide(
        {
          participants,
          lines,
          hop,
          mentions: parseMentions(lines.at(-1)?.text ?? "", participants),
        },
        signal,
      ),
    );
  const [only] = participants;
  if (participants.length === 1 && only?.replyMode === "auto") {
    const deciding = decide(linesThrough(request.chat.events, request.after), 0);
    yield* answerWhileDeciding(request, deps, only.id, deciding);
    return;
  }
  const limit = participants.length > 1 ? chainLimitOf(request.chat.events) : 0;
  const owed = participants.length > 1 ? (request.owed ?? []) : [];
  const present = new Set(participants.map(({ id }) => id));
  let log = request.chat;
  let line = request.after;
  for (let hop = 0; ; hop++) {
    const answering: readonly OwedLine[] = [...(hop === 0 ? owed : []), { line }];
    const asked = answering.flatMap((owe) => (owe.replies === undefined ? [owe.line] : []));
    let decided: (readonly [number, DirectorDecision])[];
    try {
      decided = await Promise.all(
        asked.map(async (seq) => [seq, await decide(linesThrough(log.events, seq), hop)] as const),
      );
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    for (const [seq, decision] of decided) yield decisionOutput(seq, decision);
    const chosen = new Map(decided.map(([seq, { replies }]) => [seq, replies]));
    const replies = answering.map((owe) => owe.replies ?? chosen.get(owe.line) ?? []);
    for (const { persona, mode } of round(replies, present)) {
      if (signal.aborted) return;
      log = await request.read();
      yield* turn(log, persona, mode);
    }
    if (signal.aborted || hop === limit) return;
    log = await request.read();
    const spoken = spokenAfter(log.events, line);
    if (spoken === null) return;
    line = spoken;
  }
}
