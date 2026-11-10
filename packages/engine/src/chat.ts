// A chat's answer to the viewer's line: the director chooses who answers, each answers in turn,
// then the director is asked again about the last persona line, each hop against a higher bar,
// until no one is chosen or the chat's chain limit is reached.
import type { UserContext } from "@eidolon/access";
import {
  type ChatEvent,
  type ChatEventDraft,
  chainLimitOf,
  parseMentions,
  summarize,
} from "@eidolon/chat";
import { settingsGeneration } from "@eidolon/config";
import {
  type Director,
  type DirectorDecision,
  type DirectorLine,
  type DirectorParticipant,
  directorFromEnv,
  directorParticipant,
} from "@eidolon/context";
import { withUsageScope } from "@eidolon/providers";
import { runTurn } from "./turn.ts";
import type { EngineDeps, LateTools, TurnOutput, TurnRequest } from "./types.ts";

type ChatLog = TurnRequest["chat"];

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
  /** Interrupts the running turn and drops every turn and hop still to come. */
  readonly signal: AbortSignal;
  /** Without it, an interruption cancels every tool, `cancelOnInterruption` or not. */
  readonly late?: LateTools;
}

export interface ChatDeps extends EngineDeps {
  /** Default: the active persona's gate role's, rebuilt when the settings change. */
  readonly director?: Pick<Director, "decide">;
}

/** Each turn's outputs, and a decision to store before the turns it chooses. */
export type ChatOutput = TurnOutput | Extract<ChatEventDraft, { readonly type: "decision" }>;

let shared: { readonly generation: number; readonly director: Director } | null = null;

function defaultDirector(): Director {
  const generation = settingsGeneration();
  if (shared?.generation !== generation) shared = { generation, director: directorFromEnv() };
  return shared.director;
}

/** The chat's lines through seq `last`, oldest first, as the director reads them. */
function linesThrough(events: readonly ChatEvent[], last: number): DirectorLine[] {
  return events.flatMap((event) =>
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

/**
 * The chat's answer to the viewer's line at seq `request.after`, with the personas and chain limit
 * the chat had then. The caller stores each `events` and `decision` output before taking the
 * next. A chat of one persona makes no decisions request and never chains. An abort ends it
 * quietly, once the running turn has given what it said.
 */
export async function* runChat(request: ChatRequest, deps: ChatDeps): AsyncGenerator<ChatOutput> {
  const { signal } = request;
  const { header } = request.chat;
  const director = deps.director ?? defaultDirector();
  const participants: DirectorParticipant[] = summarize(
    header,
    request.chat.events,
  ).participants.map((id) => directorParticipant(id));
  const limit = participants.length > 1 ? chainLimitOf(request.chat.events) : 0;
  let log = request.chat;
  let line = request.after;
  for (let hop = 0; ; hop++) {
    const lines = linesThrough(log.events, line);
    let decision: DirectorDecision;
    try {
      decision = await withUsageScope({ source: "chat", session: header.id }, () =>
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
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    yield {
      type: "decision",
      after: line,
      replies: decision.replies.map(({ persona, mode }) => ({ persona, mode })),
      source: decision.source,
      ...(Object.keys(decision.scores).length > 0 ? { scores: { ...decision.scores } } : {}),
    };
    for (const { persona } of decision.replies) {
      if (signal.aborted) return;
      log = await request.read();
      yield* runTurn(
        {
          chat: log,
          persona,
          viewer: request.viewer,
          signal,
          ...(request.late ? { late: request.late } : {}),
        },
        deps,
      );
    }
    if (signal.aborted || hop === limit) return;
    log = await request.read();
    const spoken = spokenAfter(log.events, line);
    if (spoken === null) return;
    line = spoken;
  }
}
