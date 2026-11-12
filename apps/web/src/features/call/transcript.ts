// What the call page shows of a call, rebuilt from its RTVI events: the viewer's speech and typed
// messages, the bot's replies sentence by sentence as the TTS says them, and the selfies it sends.
// On a group call, each reply names the persona who said it.
import { separator } from "@eidolon/chat";
import type { BotOutputData, TranscriptData, UserInputData } from "@pipecat-ai/client-js";
import { type MarkupToken, parseMarkup } from "../../lib/markup";

export interface UserPart {
  readonly text: string;
  readonly final: boolean;
}

export interface UserEntry {
  readonly kind: "user";
  readonly id: number;
  readonly parts: readonly UserPart[];
  /** Typed rather than said: the key its send reports back with. */
  readonly key: string | null;
  /** A typed message the bot never got. */
  readonly failed: boolean;
}

export interface BotSegment {
  /** The bot's id for it, which later progress messages name. */
  readonly id: number | null;
  readonly text: string;
  /** How much of `text` the bot has said so far. */
  readonly spoken: number;
  /** Text the bot is going to say; text it never will reads as said. */
  readonly voiced: boolean;
}

/** Who a group call's server says is speaking, as her audio starts. */
export interface Speaker {
  readonly persona: string;
  readonly name: string;
}

export interface BotEntry {
  readonly kind: "bot";
  readonly id: number;
  /** Who said it on a group call; null on a call with her alone. */
  readonly speaker: Speaker | null;
  readonly segments: readonly BotSegment[];
}

export interface SelfieEntry {
  readonly kind: "selfie";
  readonly id: number;
  /** Same-origin `/api/selfie/` paths. */
  readonly paths: readonly string[];
  /** Whose photo it is on a group call; null on a call with her alone. */
  readonly persona: string | null;
}

export type Entry = UserEntry | BotEntry | SelfieEntry;

export interface Transcript {
  readonly entries: readonly Entry[];
  readonly nextId: number;
  /** The user entry speech adds to, until the bot answers or the viewer types. */
  readonly openUser: number | null;
  /** The bot entry new sentences join, until the viewer takes a turn or a selfie lands. */
  readonly openBot: number | null;
  /** Transcriptions arrive as user-input, so their user-transcription copies are skipped. */
  readonly userInput: boolean;
  /** On a group call, the persona the caller hears now, or heard last. */
  readonly speaker: Speaker | null;
}

export const EMPTY_TRANSCRIPT: Transcript = {
  entries: [],
  nextId: 1,
  openUser: null,
  openBot: null,
  userInput: false,
  speaker: null,
};

export type TranscriptEvent =
  | {
      readonly type: "user-input";
      readonly data: Pick<UserInputData, "text" | "input_type" | "final">;
    }
  | { readonly type: "user-transcript"; readonly data: Pick<TranscriptData, "text" | "final"> }
  | { readonly type: "typed"; readonly key: string; readonly text: string }
  | { readonly type: "typed-failed"; readonly key: string }
  | { readonly type: "bot-output"; readonly data: BotOutputData }
  /** The bot was cut off: what it says next is a new reply. */
  | { readonly type: "interrupted" }
  | { readonly type: "selfie"; readonly paths: readonly string[]; readonly persona?: string | null }
  /** A group call's persona starts speaking: her replies are entries of her own. */
  | { readonly type: "speaker"; readonly speaker: Speaker }
  | { readonly type: "reset" };

// Word and token output repeats the sentences, and backchannels and expressions sit outside a reply.
const SKIPPED_OUTPUT = new Set([
  "word",
  "token",
  "backchannel",
  "expression_sound",
  "expression_pause",
]);

function append(state: Transcript, entry: Entry, open?: "user" | "bot"): Transcript {
  return {
    ...state,
    entries: [...state.entries, entry],
    nextId: state.nextId + 1,
    openUser: open === "user" ? entry.id : state.openUser,
    openBot: open === "bot" ? entry.id : state.openBot,
  };
}

function replace(state: Transcript, entry: Entry): Transcript {
  return { ...state, entries: state.entries.map((each) => (each.id === entry.id ? entry : each)) };
}

function entryOf<K extends Entry["kind"]>(
  state: Transcript,
  id: number | null,
  kind: K,
): Extract<Entry, { kind: K }> | undefined {
  const entry = id === null ? undefined : state.entries.find((each) => each.id === id);
  return entry?.kind === kind ? (entry as Extract<Entry, { kind: K }>) : undefined;
}

function addSpeech(state: Transcript, text: string, final: boolean): Transcript {
  if (text.trim() === "") return state;
  const open = entryOf(state, state.openUser, "user");
  if (open === undefined) {
    const entry: UserEntry = {
      kind: "user",
      id: state.nextId,
      parts: [{ text, final }],
      key: null,
      failed: false,
    };
    return append({ ...state, openBot: null }, entry, "user");
  }
  // An interim transcription stands in for the words until the next one, or the final, arrives.
  const last = open.parts.at(-1);
  const kept = last?.final === false ? open.parts.slice(0, -1) : open.parts;
  return { ...replace(state, { ...open, parts: [...kept, { text, final }] }), openBot: null };
}

/** How much of `text` is said once `accumulated` has been, matched loosely. */
function spokenLength(text: string, accumulated: string): number {
  if (text.startsWith(accumulated)) return accumulated.length;
  const said = accumulated.trim();
  const at = said === "" ? -1 : text.indexOf(said);
  return at === -1 ? 0 : at + said.length;
}

function addSegment(state: Transcript, segment: BotSegment): Transcript {
  const open = entryOf(state, state.openBot, "bot");
  if (open === undefined) {
    const entry: BotEntry = {
      kind: "bot",
      id: state.nextId,
      speaker: state.speaker,
      segments: [segment],
    };
    return append({ ...state, openUser: null }, entry, "bot");
  }
  return { ...replace(state, { ...open, segments: [...open.segments, segment] }), openUser: null };
}

/** Moves a segment's spoken mark, wherever its reply is; null when no segment has that id. */
function advance(state: Transcript, id: number, spoken: (segment: BotSegment) => number) {
  for (let index = state.entries.length - 1; index >= 0; index--) {
    const entry = state.entries[index]!;
    if (entry.kind !== "bot") continue;
    const at = entry.segments.findIndex((segment) => segment.id === id);
    if (at === -1) continue;
    const segment = entry.segments[at]!;
    const segments = entry.segments.with(at, {
      ...segment,
      spoken: Math.max(segment.spoken, spoken(segment)),
    });
    return { ...state, entries: state.entries.with(index, { ...entry, segments }) };
  }
  return null;
}

function addBotOutput(state: Transcript, data: BotOutputData): Transcript {
  const outputType = data.output_type ?? data.text_type ?? data.aggregated_by;
  if (outputType !== undefined && SKIPPED_OUTPUT.has(outputType)) return state;
  const status = data.spoken_status;
  if (status === "in-progress" || status === "completed") {
    // A sentence's first message announces it; the rest report how much of it has been said.
    const said = (text: string) =>
      status === "completed"
        ? text.length
        : spokenLength(text, data.spoken_progress?.accumulated_text ?? "");
    const advanced =
      data.segment_id === undefined
        ? null
        : advance(state, data.segment_id, ({ text }) => said(text));
    if (advanced !== null) return advanced;
    if (data.text === "") return state;
    return addSegment(state, {
      id: data.segment_id ?? null,
      text: data.text,
      spoken: said(data.text),
      voiced: true,
    });
  }
  if (data.text === "") return state;
  return addSegment(state, {
    id: data.segment_id ?? null,
    text: data.text,
    spoken: 0,
    voiced: data.will_be_spoken ?? false,
  });
}

export function reduceTranscript(state: Transcript, event: TranscriptEvent): Transcript {
  switch (event.type) {
    case "user-input":
      // Typed text joins when it is sent, so the bot's echo of it is skipped.
      if (event.data.input_type !== "transcription") return state;
      return addSpeech({ ...state, userInput: true }, event.data.text, event.data.final);
    case "user-transcript":
      return state.userInput ? state : addSpeech(state, event.data.text, event.data.final);
    case "typed": {
      const entry: UserEntry = {
        kind: "user",
        id: state.nextId,
        parts: [{ text: event.text, final: true }],
        key: event.key,
        failed: false,
      };
      return append({ ...state, openUser: null, openBot: null }, entry);
    }
    case "typed-failed": {
      const entry = state.entries.find((each) => each.kind === "user" && each.key === event.key);
      return entry?.kind === "user" ? replace(state, { ...entry, failed: true }) : state;
    }
    case "bot-output":
      return addBotOutput(state, event.data);
    case "interrupted":
      return state.openBot === null ? state : { ...state, openBot: null };
    case "selfie": {
      if (event.paths.length === 0) return state;
      const entry: SelfieEntry = {
        kind: "selfie",
        id: state.nextId,
        paths: event.paths,
        persona: event.persona ?? null,
      };
      return append({ ...state, openBot: null }, entry);
    }
    case "speaker": {
      // The director can hand the floor on with no word from the viewer between two replies.
      const open = entryOf(state, state.openBot, "bot");
      const handedOn = open !== undefined && open.speaker?.persona !== event.speaker.persona;
      return { ...state, speaker: event.speaker, openBot: handedOn ? null : state.openBot };
    }
    case "reset":
      return EMPTY_TRANSCRIPT;
  }
}

/** Who a server message says is speaking now; null for any message but a group call's label. */
export function speakerOf(data: unknown): Speaker | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, persona, name } = data as {
    readonly type?: unknown;
    readonly persona?: unknown;
    readonly name?: unknown;
  };
  if (type !== "speaker" || typeof persona !== "string" || persona === "") return null;
  return { persona, name: typeof name === "string" && name.trim() !== "" ? name : persona };
}

/** A user entry's words: what was said, and the part still being heard with its leading space. */
export function userText(entry: UserEntry): { readonly said: string; readonly hearing: string } {
  let said = "";
  let hearing = "";
  for (const part of entry.parts) {
    if (part.final) said += separator(said, part.text) + part.text;
    else hearing = part.text;
  }
  return { said, hearing: separator(said, hearing) + hearing };
}

/** A piece of a reply, pending while the bot has yet to say it. */
export type BotRun = MarkupToken & { readonly pending: boolean };

/**
 * A reply as markup runs. Its sentences are parsed as one text, so a tag pair the sentence
 * splitter cut in two still pairs up.
 */
export function botRuns(entry: BotEntry): BotRun[] {
  let source = "";
  const pending: (readonly [number, number])[] = [];
  for (const segment of entry.segments) {
    source += separator(source, segment.text);
    if (segment.voiced && segment.spoken < segment.text.length) {
      pending.push([source.length + segment.spoken, source.length + segment.text.length]);
    }
    source += segment.text;
  }
  const isPending = (at: number) => pending.some(([from, to]) => from <= at && at < to);
  // Unspaced sentences pending back to back share a bound, which would cut an empty run.
  const bounds = [...new Set(pending.flat())];

  const runs: BotRun[] = [];
  for (const token of parseMarkup(source)) {
    if (token.kind !== "text") {
      runs.push({ ...token, pending: isPending(token.start) });
      continue;
    }
    const end = token.start + token.text.length;
    let from = token.start;
    for (const to of [...bounds.filter((at) => at > token.start && at < end), end]) {
      runs.push({ ...token, start: from, text: source.slice(from, to), pending: isPending(from) });
      from = to;
    }
  }
  return runs;
}
