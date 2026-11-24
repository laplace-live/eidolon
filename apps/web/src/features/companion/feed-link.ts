// The main window's end of the port to the desktop companion's page: what it tells her of the
// active persona, the shell's call and the open chat, and what of the call is hers.
import type { Direction } from "@laplace.live/eidolon-sdk/avatar";
import type { QueryClient } from "@tanstack/react-query";
import { personasQuery, settingsQuery } from "@/components/settings-form/queries";
import { callBlocker } from "@/features/call/blockers";
import type { CallPhase } from "@/features/call/phase";
import type { CallTarget } from "@/features/call/target";
import type { Status } from "@/lib/api";
import { characterModelsQuery } from "@/lib/character-models";
import { statusQuery } from "@/lib/query";
import type { PortLike } from "./page-port";
import { type ChatFact, type CompanionCall, type ToApp, type ToCompanion, toApp } from "./protocol";

/** The mouth messages' period: about 30 a second. */
export const MOUTH_SEND_MS = 33;
/**
 * How much early a mouth message may still go: a 33 ms timer's runs came 28 to 38 ms apart in
 * Chromium, and a gate of a whole MOUTH_SEND_MS on them sent about 19 a second.
 */
export const MOUTH_SLACK_MS = 8;

const sameCall = (a: CompanionCall, b: CompanionCall): boolean =>
  a.up === b.up &&
  a.live === b.live &&
  a.hers === b.hers &&
  a.micOn === b.micOn &&
  a.callable === b.callable;

/** directionOf builds a new direction at each call, so two are compared field by field. */
function sameDirection(a: Direction, b: Direction): boolean {
  return (
    a.persona === b.persona &&
    a.mood.length === b.mood.length &&
    a.mood.every((tag, index) => tag === b.mood[index]) &&
    a.pulse === b.pulse &&
    a.speaking === b.speaking &&
    a.listening === b.listening &&
    a.thinking === b.thinking &&
    a.looking === b.looking &&
    a.gesture?.name === b.gesture?.name &&
    a.gesture?.seq === b.gesture?.seq
  );
}

const performanceNow = () => performance.now();

/** The main window's end of the port: what the companion was told last, sent again to a new port. */
export class FeedLink {
  readonly #receive: (message: ToApp) => void;
  readonly #now: () => number;
  #port: PortLike | null = null;
  #persona: { readonly id: string; readonly stamp: string } | null = null;
  #call: CompanionCall | null = null;
  /** Her voice message playing now, as told, and when: her page loaded anew hears it from there. */
  #voice: { readonly fact: Extract<ChatFact, { type: "voice" }>; readonly at: number } | null =
    null;
  /** The last direction sent to this port. */
  #direction: Direction | null = null;
  /** The widest mouth level since the last one sent, and when the next may go. */
  #widest = 0;
  #mouthDue = Number.NEGATIVE_INFINITY;

  constructor(receive: (message: ToApp) => void, now: () => number = performanceNow) {
    this.#receive = receive;
    this.#now = now;
  }

  /**
   * Closes the port before it, forgets the last direction sent, then sends the last persona and call
   * told, and her voice message still playing.
   */
  connect(port: PortLike): void {
    const before = this.#port;
    this.#port = port;
    before?.close();
    this.#direction = null;
    this.#widest = 0;
    this.#mouthDue = Number.NEGATIVE_INFINITY;
    port.onmessage = (event) => {
      if (this.#port !== port) return;
      const message = toApp(event.data);
      if (message !== null) this.#receive(message);
    };
    port.addEventListener("close", () => {
      if (this.#port === port) this.disconnect();
    });
    if (this.#persona !== null) this.#send({ type: "persona", ...this.#persona });
    if (this.#call !== null) this.#send({ type: "call", call: this.#call });
    if (this.#voice !== null) {
      const { fact, at } = this.#voice;
      this.#send({ ...fact, position: fact.position + (this.#now() - at) / 1000 });
    }
  }

  disconnect(): void {
    const port = this.#port;
    if (port === null) return;
    this.#port = null;
    port.close();
  }

  /** A port is connected. */
  get linked(): boolean {
    return this.#port !== null;
  }

  /** Kept; sent when it changed. */
  persona(id: string, stamp: string): void {
    if (this.#persona?.id === id && this.#persona.stamp === stamp) return;
    if (this.#persona?.id !== id) this.#voice = null;
    this.#persona = { id, stamp };
    this.#send({ type: "persona", id, stamp });
  }

  /** Kept; sent when it changed. */
  call(call: CompanionCall): void {
    if (this.#call !== null && sameCall(this.#call, call)) return;
    this.#call = call;
    this.#send({ type: "call", call });
  }

  /** Sent when it differs, field by field, from the last one sent to this port. */
  direction(direction: Direction): void {
    if (this.#port === null) return;
    if (this.#direction !== null && sameDirection(this.#direction, direction)) return;
    this.#direction = direction;
    this.#send({ type: "direction", direction });
  }

  /** The widest level since the last send, sent about every MOUTH_SEND_MS and up to MOUTH_SLACK_MS early. */
  mouth(level: number): void {
    if (this.#port === null) return;
    this.#widest = Math.max(this.#widest, level);
    const at = this.#now();
    if (at < this.#mouthDue - MOUTH_SLACK_MS) return;
    this.#send({ type: "mouth", level: this.#widest });
    this.#widest = 0;
    // An early message never pulls the next one earlier.
    this.#mouthDue = Math.max(at, this.#mouthDue) + MOUTH_SEND_MS;
  }

  /** Sent when it is the persona told's: she is the active persona alone. */
  chat(fact: ChatFact): void {
    if (fact.persona !== this.#persona?.id) return;
    if (fact.type === "voice") {
      if (fact.state === "playing") this.#voice = { fact, at: this.#now() };
      // Playing one message pauses the last, whose pause can come after the new one plays.
      else if (this.#voice?.fact.chat === fact.chat && this.#voice.fact.seq === fact.seq) {
        this.#voice = null;
      }
    }
    this.#send(fact);
  }

  #send(message: ToCompanion): void {
    this.#port?.postMessage(message);
  }
}

/** What the feed tells her of the shell's call, and whose direction in it is hers: her id in a group chat's call. */
export function feedState(
  status: Pick<Status, "keys" | "call" | "persona"> | undefined,
  call: {
    readonly target: CallTarget | null;
    readonly phase: CallPhase;
    readonly up: boolean;
    readonly micOn: boolean;
  },
): {
  readonly persona: string | null;
  readonly call: CompanionCall;
  readonly key: string | undefined;
  /** A call of hers is up: the feed sends her its direction and mouth, and main keeps this window drawing while she shows. */
  readonly feeding: boolean;
} {
  const persona = status?.persona.id ?? null;
  const { target } = call;
  const hers = target?.cast.some((member) => member.id === persona) ?? false;
  const group = target?.kind === "chat" && target.group;
  return {
    persona,
    call: {
      up: call.up,
      live: call.phase.name === "live",
      hers,
      micOn: call.micOn,
      callable: status !== undefined && !call.up && callBlocker(status) === null,
    },
    key: group && persona !== null ? persona : undefined,
    feeding: call.up && hers,
  };
}

/** Her mouth's level from the feed's meter: as read in a call of one; in a group call only while her direction speaks. */
export function mouthLevel(
  level: number,
  key: string | undefined,
  speaking: (key: string) => boolean,
): number {
  return key === undefined || speaking(key) ? level : 0;
}

/**
 * Her page changed her appearance through the API: what this window shows of it is read again, her
 * settings' rows included, which say whether her model is her own choice.
 */
export function appearanceChanged(queryClient: QueryClient, persona: string): void {
  void queryClient.invalidateQueries({
    queryKey: characterModelsQuery(persona).queryKey,
    exact: true,
  });
  void queryClient.invalidateQueries({ queryKey: personasQuery.queryKey, exact: true });
  void queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
  void queryClient.invalidateQueries({ queryKey: settingsQuery(persona).queryKey, exact: true });
  void queryClient.invalidateQueries({ queryKey: settingsQuery().queryKey, exact: true });
}
