// What crosses the port between the main window and the desktop companion's page. Both ends read
// every message through these: the two pages come from one server's build, but one may reload onto
// a newer build before the other. Neither side sends a time: each window's clock has its own origin.
import {
  type Direction,
  type DirectionGesture,
  GESTURES,
  MOOD_TAGS,
  type MoodTag,
} from "@laplace.live/eidolon-sdk/avatar";
import type { ActiveCharacterModel } from "@/lib/api";

/** A call in the main window, as her menu and her stage read it. */
export interface CompanionCall {
  /** Placed and not over: starting, connecting, live or ending. */
  readonly up: boolean;
  /** Live: Mute applies. */
  readonly live: boolean;
  /** She, the active persona, is in its cast: its direction and her mouth come over the port. */
  readonly hers: boolean;
  readonly micOn: boolean;
  /** No call is up, and /call's call with her may be placed now. */
  readonly callable: boolean;
}

export const NO_COMPANION_CALL: CompanionCall = {
  up: false,
  live: false,
  hers: false,
  micOn: true,
  callable: false,
};

/** Her messages in the chat open in the main window. */
export type ChatFact =
  | {
      readonly type: "said";
      readonly persona: string;
      readonly chat: string;
      readonly seq: number;
      readonly text: string;
    }
  | {
      readonly type: "voice";
      readonly persona: string;
      readonly chat: string;
      readonly seq: number;
      readonly text: string;
      /** The voice message's file in its chat. */
      readonly file: string;
      readonly state: "playing" | "paused" | "ended";
      /** Seconds into it, as the bubble's audio stood at the event. */
      readonly position: number;
    };

/** The main window to the companion. */
export type ToCompanion =
  /**
   * The active persona, her active model as status names it ("" for none), and her picture's
   * version in the main window, which grows at each change of it made there.
   */
  | {
      readonly type: "persona";
      readonly id: string;
      readonly stamp: string;
      readonly picture: number;
    }
  | { readonly type: "call"; readonly call: CompanionCall }
  | { readonly type: "direction"; readonly direction: Direction }
  /** The widest mouth opening, 0..1, the call's second meter read since the last. */
  | { readonly type: "mouth"; readonly level: number }
  | ChatFact;

/**
 * The companion to the main window: she changed her model or her outfit, and the window reads them
 * again. Nothing that acts on the call: her menu's call picks come from main (companion-pick).
 */
export type ToApp = { readonly type: "appearance"; readonly persona: string };

/** A persona's or a model's id, as the server mints them. */
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A chat's id: the server's lowercase UUID. */
const CHAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TEXT = 20_000;
const MAX_FILE = 200;
/** `${id}:${sha256}:${updatedAt}`, which nothing parses: only compared. */
const MAX_STAMP = 512;
const LOOKS: readonly unknown[] = ["viewer", "away", "idle"] satisfies Direction["looking"][];
const VOICE_STATES: readonly unknown[] = ["playing", "paused", "ended"] satisfies Extract<
  ChatFact,
  { type: "voice" }
>["state"][];

type Fields = Partial<Record<string, unknown>>;

function fieldsOf(value: unknown): Fields | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : null;
}

const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isMood = (value: unknown): value is MoodTag =>
  (MOOD_TAGS as readonly unknown[]).includes(value);

function callOf(value: unknown): CompanionCall | null {
  const call = fieldsOf(value);
  if (call === null) return null;
  const { up, live, hers, micOn, callable } = call;
  if (![up, live, hers, micOn, callable].every(isBoolean)) return null;
  return {
    up: up as boolean,
    live: live as boolean,
    hers: hers as boolean,
    micOn: micOn as boolean,
    callable: callable as boolean,
  };
}

function gestureOf(value: unknown): DirectionGesture | null | undefined {
  if (value === null) return null;
  const gesture = fieldsOf(value);
  if (gesture === null) return undefined;
  const { name, seq } = gesture;
  if (!(GESTURES as readonly unknown[]).includes(name)) return undefined;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) return undefined;
  return { name: name as DirectionGesture["name"], seq: seq as number };
}

function directionOf(value: unknown): Direction | null {
  const direction = fieldsOf(value);
  if (direction === null) return null;
  const { persona, mood, pulse, speaking, listening, thinking, looking } = direction;
  if (persona !== null && typeof persona !== "string") return null;
  if (!Array.isArray(mood) || mood.length > 2 || !mood.every(isMood)) return null;
  if (pulse !== null && !isMood(pulse)) return null;
  if (![speaking, listening, thinking].every(isBoolean)) return null;
  if (!LOOKS.includes(looking)) return null;
  const gesture = gestureOf(direction.gesture);
  if (gesture === undefined) return null;
  return {
    persona,
    mood: [...mood],
    pulse,
    speaking: speaking as boolean,
    listening: listening as boolean,
    thinking: thinking as boolean,
    looking: looking as Direction["looking"],
    gesture,
  };
}

const isSeq = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_TEXT;

function isFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_FILE &&
    !/[/\\]/.test(value) &&
    !value.includes("..")
  );
}

function factOf(type: "said" | "voice", message: Fields): ChatFact | null {
  const { persona, chat, seq, text } = message;
  if (!isId(persona) || typeof chat !== "string" || !CHAT.test(chat)) return null;
  if (!isSeq(seq) || !isText(text)) return null;
  if (type === "said") return { type, persona, chat, seq, text };
  const { file, state, position } = message;
  if (!isFile(file) || !VOICE_STATES.includes(state)) return null;
  if (typeof position !== "number" || !Number.isFinite(position) || position < 0) return null;
  return {
    type,
    persona,
    chat,
    seq,
    text,
    file,
    state: state as Extract<ChatFact, { type: "voice" }>["state"],
    position,
  };
}

/** A message from the main window, as the companion's page takes it; null for one that doesn't read. */
export function toCompanion(data: unknown): ToCompanion | null {
  const message = fieldsOf(data);
  if (message === null) return null;
  switch (message.type) {
    case "persona": {
      // A main window on a build before the picture's version sends none.
      const { id, stamp, picture = 0 } = message;
      if (!isId(id) || typeof stamp !== "string" || stamp.length > MAX_STAMP) return null;
      if (!Number.isSafeInteger(picture) || (picture as number) < 0) return null;
      return { type: "persona", id, stamp, picture: picture as number };
    }
    case "call": {
      const call = callOf(message.call);
      return call === null ? null : { type: "call", call };
    }
    case "direction": {
      const direction = directionOf(message.direction);
      return direction === null ? null : { type: "direction", direction };
    }
    case "mouth": {
      const { level } = message;
      if (typeof level !== "number" || !Number.isFinite(level)) return null;
      return { type: "mouth", level: Math.min(Math.max(level, 0), 1) };
    }
    case "said":
    case "voice":
      return factOf(message.type, message);
    default:
      return null;
  }
}

/** A message from the companion's page, as the main window takes it; null for one that doesn't read. */
export function toApp(data: unknown): ToApp | null {
  const message = fieldsOf(data);
  if (message === null || message.type !== "appearance" || !isId(message.persona)) return null;
  return { type: "appearance", persona: message.persona };
}

/** `${id}:${sha256}:${updatedAt}` of her active model, "" for none. */
export function appearanceStamp(model: ActiveCharacterModel | null): string {
  return model === null ? "" : `${model.id}:${model.sha256}:${model.updatedAt}`;
}
