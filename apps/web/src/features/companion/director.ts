// What the desktop companion's face and head do from moment to moment, pure so a test can run it
// on a clock of its own. Times are milliseconds on the page's performance.now().
import {
  type Direction,
  type DirectionGesture,
  type DirectionState,
  direct,
  directionOf,
  directionState,
  type Gesture,
  type MoodTag,
} from "@laplace.live/eidolon-sdk/avatar";
import { type CompanionCall, NO_COMPANION_CALL } from "./protocol";

export const COMPANION_TICK_MS = 100;
export const DOZE_MS = 300_000;
/** How long a tap lends her its mood, waking her included. */
export const PULSE_MS = 2_000;
export const REACT_GAP_MS = 500;
export const PICK_UP_MS = 1_500;
export const POKES = 5;
export const POKE_WINDOW_MS = 3_000;
/** How long the pokes' pout lasts, and her rest from taps after it. */
export const POKE_REST_MS = 3_000;

export type TapArea = "head" | "body";

export interface VoiceKey {
  readonly chat: string;
  readonly seq: number;
}

interface Message {
  readonly chat: string;
  readonly seq: number;
  readonly text: string;
}

const same = (key: VoiceKey | null, message: VoiceKey): boolean =>
  key !== null && key.chat === message.chat && key.seq === message.seq;

/**
 * Her direction on the desktop: her own, from her chat replies and voice messages; the call's while
 * she is on one; and what she does by herself, at a tap, a pick-up, and after a while alone.
 */
export class CompanionDirector {
  #own: DirectionState = directionState();
  #call: CompanionCall = NO_COMPANION_CALL;
  #callDirection: Direction | null = null;
  /** The message whose reply she last made, so one that arrives and then plays is made once. */
  #announced: VoiceKey | null = null;
  #voicing: VoiceKey | null = null;
  /** A mood of her own over the direction's, until a time. */
  #lent: { readonly mood: MoodTag; readonly until: number } | null = null;
  /**
   * The gestures she shows, numbered by her alone: a source's gesture plays as a new number the
   * first time its own number shows, so the call's numbers and hers never meet on the stage.
   */
  #gesture: DirectionGesture | null = null;
  #seq = 0;
  readonly #seen: { own: number | null; call: number | null } = { own: null, call: null };
  #touched: number;
  #pokes: number[] = [];
  #restUntil = Number.NEGATIVE_INFINITY;
  #reacted = Number.NEGATIVE_INFINITY;

  constructor(at: number) {
    this.#touched = at;
  }

  said(message: Message, at: number): void {
    this.#touched = at;
    this.#announce(message, at);
  }

  voice(message: Message, playing: boolean, at: number): void {
    if (this.#herCall()) return;
    if (playing) {
      this.#touched = at;
      this.#announce(message, at);
      this.#own = direct(this.#own, { type: "bot-started-speaking", at });
      this.#voicing = { chat: message.chat, seq: message.seq };
      return;
    }
    if (!same(this.#voicing, message)) return;
    this.#stopVoice(at);
  }

  call(call: CompanionCall, at: number): void {
    const before = this.#call;
    const was = before.up && before.hers;
    this.#call = call;
    // A call's end counts as one, so she dozes off only after DOZE_MS without one.
    if (call.up !== before.up) this.#touched = at;
    const hers = this.#herCall();
    if (hers && !was) {
      this.#seen.call = null;
      if (this.#voicing !== null) this.#stopVoice(at);
    }
    if (hers) return;
    this.#callDirection = null;
    // What her own direction gestured during the call is past once she is back to it.
    if (was) this.#note("own", directionOf(this.#own).gesture, false);
  }

  callDirection(direction: Direction): void {
    if (this.#herCall()) this.#callDirection = direction;
  }

  tap(area: TapArea, at: number): void {
    const dozing = this.dozing(at);
    this.#touched = at;
    if (dozing) {
      this.#react("surprised", at + PULSE_MS, at);
      return;
    }
    if (at < this.#restUntil) return;
    this.#pokes = this.#pokes.filter((poke) => at - poke < POKE_WINDOW_MS);
    this.#pokes.push(at);
    if (this.#pokes.length >= POKES) {
      this.#pokes = [];
      this.#restUntil = at + POKE_REST_MS;
      this.#react("pout", at + POKE_REST_MS, at);
      this.#play("shake");
      return;
    }
    if (at - this.#reacted < REACT_GAP_MS) return;
    if (area === "head") {
      this.#react("shy", at + PULSE_MS, at);
      this.#play("nod");
    } else {
      this.#react("surprised", at + PULSE_MS, at);
    }
  }

  pickUp(at: number): void {
    this.#touched = at;
    this.#react("surprised", at + PICK_UP_MS, at);
  }

  /** A menu opened, a press on her picture: she was touched. */
  touch(at: number): void {
    this.#touched = at;
  }

  /** Her stage was made anew, which plays any gesture it hasn't seen: it gets none until her next. */
  newStage(): void {
    this.#gesture = null;
  }

  /**
   * Another persona is active: she starts over as on a new page, keeping only the call and her
   * gesture numbering. The last one's voice message would never end here: the main window passes on
   * only the active persona's messages.
   */
  newPersona(at: number): void {
    this.#own = direct(this.#own, { type: "reset", at });
    this.#announced = null;
    this.#voicing = null;
    this.#lent = null;
    this.#touched = at;
    this.#pokes = [];
    this.#restUntil = Number.NEGATIVE_INFINITY;
    this.#reacted = Number.NEGATIVE_INFINITY;
  }

  tick(at: number): void {
    this.#own = direct(this.#own, { type: "tick", at });
    if (this.#lent !== null && this.#lent.until <= at) this.#lent = null;
  }

  direction(at: number): Direction {
    const own = directionOf(this.#own);
    const call = this.#herCall() ? this.#callDirection : null;
    // Her own gestures are noted during a call too, so going back to her own replays none.
    this.#note("own", own.gesture, call === null);
    if (call !== null) this.#note("call", call.gesture, true);
    const base = call ?? own;
    const dozing = this.dozing(at);
    const lent = this.#lent !== null && this.#lent.until > at ? this.#lent.mood : null;
    return {
      persona: base.persona,
      mood: dozing ? ["lazy"] : [...base.mood],
      pulse: lent ?? (dozing ? null : base.pulse),
      speaking: base.speaking,
      listening: base.listening,
      thinking: base.thinking,
      looking: base.listening ? "viewer" : base.thinking ? "away" : "idle",
      gesture: this.#gesture === null ? null : { ...this.#gesture },
    };
  }

  dozing(at: number): boolean {
    return !this.#call.up && this.#voicing === null && at - this.#touched >= DOZE_MS;
  }

  /** Her eyes may follow the cursor: awake, and no call of hers. */
  follows(at: number): boolean {
    return !this.dozing(at) && !this.#herCall();
  }

  /** Her voice message playing now; null for none. */
  get voicing(): VoiceKey | null {
    return this.#voicing;
  }

  #herCall(): boolean {
    return this.#call.up && this.#call.hers;
  }

  #announce(message: Message, at: number): void {
    if (same(this.#announced, message)) return;
    this.#announced = { chat: message.chat, seq: message.seq };
    this.#own = direct(this.#own, { type: "reply", at, text: message.text });
  }

  #stopVoice(at: number): void {
    this.#own = direct(this.#own, { type: "bot-stopped-speaking", at });
    this.#voicing = null;
  }

  #react(mood: MoodTag, until: number, at: number): void {
    this.#lent = { mood, until };
    this.#reacted = at;
  }

  #play(name: Gesture): void {
    this.#seq += 1;
    this.#gesture = { name, seq: this.#seq };
  }

  #note(source: "own" | "call", gesture: DirectionGesture | null, play: boolean): void {
    if (gesture === null || gesture.seq === this.#seen[source]) return;
    this.#seen[source] = gesture.seq;
    if (play) this.#play(gesture.name);
  }
}
