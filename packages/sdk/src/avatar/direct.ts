// Her direction on a call, from the call's events and the cues in what she says: her mood, whether
// she speaks, listens or thinks, where she looks, and the gestures she makes. Pure and plain data, so
// it runs where the call runs and can cross a MessagePort to wherever she is drawn.
import { type MarkupToken, parseMarkup } from "../markup.ts";
import type { Gesture } from "./model.ts";
import { type MoodTag, moodTags, soundCueEffect } from "./moods.ts";

/** A call event, at a time in milliseconds on any steady clock. */
export type DirectionEvent =
  | { readonly type: "user-started-speaking"; readonly at: number }
  | { readonly type: "user-stopped-speaking"; readonly at: number }
  /** A transcript of the viewer's words arrived, or a line the viewer typed was sent. */
  | { readonly type: "user-words"; readonly at: number }
  | { readonly type: "bot-llm-started"; readonly at: number }
  | { readonly type: "bot-started-speaking"; readonly at: number }
  | { readonly type: "bot-stopped-speaking"; readonly at: number }
  | { readonly type: "bot-interrupted"; readonly at: number }
  | {
      readonly type: "bot-output";
      readonly at: number;
      /** botOutput's `segment_id`. */
      readonly segment?: number | null;
      readonly text: string;
      /** botOutput's `spoken_status`. */
      readonly status: "new" | "in-progress" | "completed";
      /** How much of `text` has been heard: `spoken_progress.accumulated_text`'s length. */
      readonly spoken?: number;
      /** botOutput's `output_type` (or `text_type`); word, token, backchannel and expression outputs are skipped. */
      readonly output?: string;
    }
  /** She called a tool. */
  | { readonly type: "function-call"; readonly at: number }
  /** A group call's persona is about to speak: the bot events after it are hers. */
  | { readonly type: "speaker"; readonly at: number; readonly persona: string }
  /** Time passing: fires the cues now due and ends the moods they lent. */
  | { readonly type: "tick"; readonly at: number }
  /** A reply of hers in a chat, which no voice says. */
  | { readonly type: "reply"; readonly at: number; readonly text: string }
  /** Start over, keeping gestures' numbering so a stage never mistakes a new one for one it played. */
  | { readonly type: "reset"; readonly at: number };

/** A gesture to make once: a new `seq` is a new gesture. */
export interface DirectionGesture {
  readonly name: Gesture;
  readonly seq: number;
}

/** Where she is and what she does now, for one persona of the call. */
export interface Direction {
  /** The persona it is for; null on a call with her alone. */
  readonly persona: string | null;
  /** The mood of her reply, from the direction it opened with; empty when it had none. */
  readonly mood: readonly MoodTag[];
  /** A mood a cue lends for a moment, over the reply's. */
  readonly pulse: MoodTag | null;
  readonly speaking: boolean;
  readonly listening: boolean;
  readonly thinking: boolean;
  readonly looking: "viewer" | "away" | "idle";
  readonly gesture: DirectionGesture | null;
}

interface PendingCue {
  readonly name: string;
  /** Where in the segment's text the cue sits. */
  readonly offset: number;
  /** The voiced letters before it. */
  readonly letters: number;
}

interface SegmentState {
  readonly id: number | null;
  /** When it was announced, the cursor reaching it. */
  readonly at: number;
  /** Whether its voice reports how much of it was heard, which then times its cues. */
  readonly timed: boolean;
  readonly cues: readonly PendingCue[];
}

interface PersonaState {
  readonly persona: string | null;
  readonly mood: readonly MoodTag[];
  /** Whether a reply is open: its later segments keep its mood. */
  readonly replying: boolean;
  readonly pulse: { readonly mood: MoodTag; readonly until: number } | null;
  readonly speaking: boolean;
  readonly gesture: DirectionGesture | null;
  readonly segments: readonly SegmentState[];
}

/** What `direct` keeps between events: plain data, to be treated as opaque. */
export interface DirectionState {
  readonly speaker: string | null;
  readonly listening: boolean;
  /** Words came in the viewer's turn. */
  readonly heard: boolean;
  /** The viewer stopped speaking before their words came in. */
  readonly awaitingWords: boolean;
  readonly thinking: boolean;
  /** The nod everyone gives the viewer. */
  readonly gesture: DirectionGesture | null;
  readonly seq: number;
  readonly personas: readonly PersonaState[];
}

// Word and token outputs repeat the sentences, and backchannels and expressions sit outside a reply.
const SKIPPED_OUTPUT: ReadonlySet<string> = new Set([
  "word",
  "token",
  "backchannel",
  "expression_sound",
  "expression_pause",
]);

/** Her voice's pace in voiced letters a second, which times cues when it reports no progress. */
const LETTERS_PER_SECOND = 4.5;

const VOICED = /[\p{L}\p{N}]/u;

/** Segments kept for their cues, per persona; older ones are dropped. */
const MAX_SEGMENTS = 16;

export function directionState(): DirectionState {
  return {
    speaker: null,
    listening: false,
    heard: false,
    awaitingWords: false,
    thinking: false,
    gesture: null,
    seq: 0,
    personas: [],
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Draft = Mutable<Omit<DirectionState, "personas">> & { personas: PersonaDraft[] };
type PersonaDraft = Mutable<Omit<PersonaState, "segments">> & { segments: SegmentState[] };

function draftOf(state: DirectionState): Draft {
  return {
    ...state,
    personas: state.personas.map((persona) => ({ ...persona, segments: [...persona.segments] })),
  };
}

function personaOf(draft: Draft, key: string | null): PersonaDraft {
  let persona = draft.personas.find((each) => each.persona === key);
  if (persona === undefined) {
    persona = {
      persona: key,
      mood: [],
      replying: false,
      pulse: null,
      speaking: false,
      gesture: null,
      segments: [],
    };
    draft.personas.push(persona);
  }
  return persona;
}

/** The persona whose segment `id` is, else the one speaking now. */
function ownerOf(draft: Draft, id: number | null | undefined): string | null {
  if (id !== null && id !== undefined) {
    const owner = draft.personas.find((each) => each.segments.some((segment) => segment.id === id));
    if (owner !== undefined) return owner.persona;
  }
  return draft.speaker;
}

function nextGesture(draft: Draft, name: Gesture): DirectionGesture {
  draft.seq += 1;
  return { name, seq: draft.seq };
}

function fire(draft: Draft, persona: PersonaDraft, cue: PendingCue, at: number): void {
  const effect = soundCueEffect(cue.name);
  if (effect === null) return;
  if (effect.mood !== undefined) {
    persona.pulse = { mood: effect.mood, until: at + effect.seconds * 1000 };
  }
  if (effect.gesture !== undefined) persona.gesture = nextGesture(draft, effect.gesture);
}

/** Fires a segment's cues that `due` picks, keeping the rest; a segment left with none goes. */
function fireWhere(
  draft: Draft,
  persona: PersonaDraft,
  segment: SegmentState,
  at: number,
  due: (cue: PendingCue) => boolean,
  update: Partial<Pick<SegmentState, "timed">> = {},
): void {
  const left: PendingCue[] = [];
  for (const cue of segment.cues) {
    if (due(cue)) fire(draft, persona, cue, at);
    else left.push(cue);
  }
  const index = persona.segments.indexOf(segment);
  if (index === -1) return;
  if (left.length === 0) persona.segments.splice(index, 1);
  else persona.segments[index] = { ...segment, ...update, cues: left };
}

/** Ends lent moods that ran out, and fires the cues their voice's pace says are heard by now. */
function advance(draft: Draft, at: number): void {
  for (const persona of draft.personas) {
    if (persona.pulse !== null && persona.pulse.until <= at) persona.pulse = null;
    for (const segment of [...persona.segments]) {
      if (segment.timed) continue;
      fireWhere(
        draft,
        persona,
        segment,
        at,
        (cue) => segment.at + (cue.letters / LETTERS_PER_SECOND) * 1000 <= at,
      );
    }
  }
}

function blank(token: MarkupToken): boolean {
  return token.kind === "text" && token.text.trim() === "";
}

/** The mood the direction a segment opens with tags; empty when it opens with none. */
function openingMood(tokens: readonly MarkupToken[]): MoodTag[] {
  const first = tokens.find((token) => !blank(token));
  return first?.kind === "direction" ? moodTags(first.text) : [];
}

function cuesOf(tokens: readonly MarkupToken[]): PendingCue[] {
  const cues: PendingCue[] = [];
  let letters = 0;
  for (const token of tokens) {
    if (token.kind === "text") {
      for (const char of token.text) if (VOICED.test(char)) letters++;
    } else if (token.kind === "cue") {
      cues.push({ name: token.name, offset: token.start, letters });
    }
  }
  return cues;
}

/** A segment the listener starts hearing: the first of a reply sets its mood; cues before any word fire now. */
function announce(
  draft: Draft,
  key: string | null,
  id: number | null,
  text: string,
  at: number,
): void {
  const persona = personaOf(draft, key);
  if (id !== null && persona.segments.some((segment) => segment.id === id)) return;
  draft.thinking = false;
  const tokens = parseMarkup(text);
  if (!persona.replying) {
    persona.mood = openingMood(tokens);
    persona.replying = true;
  }
  const later: PendingCue[] = [];
  for (const cue of cuesOf(tokens)) {
    if (cue.letters === 0) fire(draft, persona, cue, at);
    else later.push(cue);
  }
  if (later.length === 0) return;
  persona.segments.push({ id, at, timed: false, cues: later });
  if (persona.segments.length > MAX_SEGMENTS) persona.segments.shift();
}

function botOutput(draft: Draft, event: Extract<DirectionEvent, { type: "bot-output" }>): void {
  if (event.output !== undefined && SKIPPED_OUTPUT.has(event.output)) return;
  const id = event.segment ?? null;
  if (event.status === "new") {
    announce(draft, draft.speaker, id, event.text, event.at);
    return;
  }
  if (id === null) return;
  const persona = draft.personas.find((each) => each.persona === ownerOf(draft, id));
  const segment = persona?.segments.find((each) => each.id === id);
  if (persona === undefined || segment === undefined) return;
  if (event.status === "completed") {
    fireWhere(draft, persona, segment, event.at, () => true);
  } else if (event.spoken !== undefined) {
    const spoken = event.spoken;
    fireWhere(draft, persona, segment, event.at, (cue) => spoken > cue.offset, { timed: true });
  }
}

/** Her reply is over for every persona not speaking now: what comes next opens a new one. */
function closeReplies(draft: Draft): void {
  for (const persona of draft.personas) if (!persona.speaking) persona.replying = false;
}

/** The direction after a call event. */
export function direct(state: DirectionState, event: DirectionEvent): DirectionState {
  if (event.type === "reset") return { ...directionState(), seq: state.seq };
  const draft = draftOf(state);
  advance(draft, event.at);
  switch (event.type) {
    case "user-started-speaking":
      draft.listening = true;
      draft.heard = false;
      draft.awaitingWords = false;
      draft.thinking = false;
      break;
    case "user-stopped-speaking":
      draft.listening = false;
      if (draft.heard) {
        draft.gesture = nextGesture(draft, "nod");
        draft.thinking = true;
      } else {
        draft.awaitingWords = true;
      }
      draft.heard = false;
      break;
    case "user-words":
      closeReplies(draft);
      if (draft.listening) {
        draft.heard = true;
      } else if (draft.awaitingWords) {
        draft.awaitingWords = false;
        draft.gesture = nextGesture(draft, "nod");
        draft.thinking = true;
      }
      break;
    case "bot-llm-started":
    case "function-call":
      draft.thinking = true;
      break;
    case "bot-started-speaking":
      personaOf(draft, draft.speaker).speaking = true;
      draft.thinking = false;
      draft.awaitingWords = false;
      break;
    case "bot-stopped-speaking":
      personaOf(draft, draft.speaker).speaking = false;
      break;
    case "bot-interrupted": {
      const persona = personaOf(draft, draft.speaker);
      persona.speaking = false;
      persona.segments = [];
      for (const each of draft.personas) each.replying = false;
      break;
    }
    case "bot-output":
      botOutput(draft, event);
      break;
    case "speaker":
      draft.speaker = event.persona;
      personaOf(draft, event.persona).replying = false;
      break;
    case "reply":
      personaOf(draft, draft.speaker).replying = false;
      announce(draft, draft.speaker, null, event.text, event.at);
      break;
    case "tick":
      break;
  }
  return draft;
}

/** The direction for a persona of the call: the one speaking, or her alone, unless named. */
export function directionOf(state: DirectionState, persona?: string | null): Direction {
  const key = persona === undefined ? state.speaker : persona;
  const own = state.personas.find((each) => each.persona === key);
  const speaking = own?.speaking ?? false;
  const thinking = state.thinking && !speaking;
  const mine = own?.gesture ?? null;
  const shared = state.gesture;
  const gesture = mine === null || (shared !== null && shared.seq > mine.seq) ? shared : mine;
  return {
    persona: key,
    mood: [...(own?.mood ?? [])],
    pulse: own?.pulse?.mood ?? null,
    speaking,
    listening: state.listening,
    thinking,
    looking: state.listening ? "viewer" : thinking ? "away" : "idle",
    gesture: gesture === null ? null : { ...gesture },
  };
}
