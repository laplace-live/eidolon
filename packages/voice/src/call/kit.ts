// What every call runs on: its one mailbox, the timers that post to it, the idle timeout, and the
// streams it closes at the end, whose meters flush as they close. Transport, provider and timer
// callbacks only post here; the Floor reads it, one event at a time.
import type { ChatEventDraft } from "@eidolon/chat";
import { AsyncQueue, errorText, logger } from "@eidolon/config";
import type { CallChatOutput } from "@eidolon/engine";
import type { MouthEvent } from "../output/mouth.ts";
import type { RtviInbound } from "../rtvi/codec.ts";
import type { Clock, CursorEvent, EarEvent, Heard } from "../types.ts";

/** pipedog's `IDLE_TIMEOUT_SECS`: `apps/web/src/features/call/phase.ts` counts on at least 285. */
export const IDLE_TIMEOUT_MS = 300_000;

export type TimerName =
  /** The call has been idle: nothing heard, said or played. */
  | "idle"
  /** The Speaker has stayed drained this long while her reply is still open. */
  | "drain-fallback"
  /** `disconnect-bot` waited this long for her audio to play out. */
  | "disconnect"
  /** The call's end waited this long for her reply's `ended`. */
  | "end";

export type Effect =
  | { readonly type: "voice"; readonly voice: string }
  | { readonly type: "server-message"; readonly data: Readonly<Record<string, unknown>> };

export type LoopEvent =
  | { readonly source: "rtvi"; readonly message: RtviInbound }
  | { readonly source: "ear"; readonly event: EarEvent }
  /** A line of reply `reply`'s turn. */
  | { readonly source: "reply"; readonly reply: string; readonly out: CallChatOutput }
  /** Its turn asks what was heard of it, which ends its speech once its earlier lines are in. */
  | { readonly source: "heard"; readonly reply: string; readonly answer: (heard: Heard) => void }
  /** One of its tools acts on the call. */
  | { readonly source: "effect"; readonly reply: string; readonly effect: Effect }
  | { readonly source: "mouth"; readonly event: MouthEvent }
  | { readonly source: "speaker"; readonly event: CursorEvent }
  /** An async tool of `persona`'s settled. */
  | {
      readonly source: "async-result";
      readonly persona: string;
      readonly drafts: readonly ChatEventDraft[];
    }
  /** `token` tells a timer from the one that replaced it. */
  | { readonly source: "timer"; readonly timer: TimerName; readonly token: number }
  | { readonly source: "transport" }
  | { readonly source: "shutdown" };

interface Closable {
  close(): Promise<void>;
}

export class CallKit {
  readonly clock: Clock;
  readonly #mailbox = new AsyncQueue<LoopEvent>();
  readonly #timers = new Map<TimerName, { readonly token: number; readonly cancel: () => void }>();
  readonly #owned: { readonly name: string; readonly stream: Closable }[] = [];
  #nextToken = 1;
  /** When something last happened, for the idle timeout. */
  #active: number;

  constructor(clock: Clock) {
    this.clock = clock;
    this.#active = clock.now();
  }

  /** Never blocks, and drops what comes once the call has stopped reading. */
  readonly post = (event: LoopEvent): void => {
    this.#mailbox.push(event);
  };

  /** Each producer's events in the order it posted them. */
  get events(): AsyncIterable<LoopEvent> {
    return this.#mailbox;
  }

  /** The call reads no more: what is still queued and what comes later are dropped. */
  stop(): void {
    this.#mailbox.drop();
    for (const name of [...this.#timers.keys()]) this.cancel(name);
  }

  get stopped(): boolean {
    return this.#mailbox.closed;
  }

  /** Arms `name` for `ms`, replacing it if it was armed. */
  arm(name: TimerName, ms: number): void {
    this.cancel(name);
    const token = this.#nextToken++;
    const cancel = this.clock.setTimer(ms, () =>
      this.post({ source: "timer", timer: name, token }),
    );
    this.#timers.set(name, { token, cancel });
  }

  cancel(name: TimerName): void {
    this.#timers.get(name)?.cancel();
    this.#timers.delete(name);
  }

  /** Whether `event` is the latest arming of its timer, which it then disarms. */
  fired(event: Extract<LoopEvent, { source: "timer" }>): boolean {
    if (this.#timers.get(event.timer)?.token !== event.token) return false;
    this.#timers.delete(event.timer);
    return true;
  }

  /** Something happened: the idle timeout counts from now. */
  active(): void {
    this.#active = this.clock.now();
    if (!this.#timers.has("idle")) this.arm("idle", IDLE_TIMEOUT_MS);
  }

  /** At the idle timer: whether the call has been idle its whole timeout, else it waits on. */
  idle(): boolean {
    const left = this.#active + IDLE_TIMEOUT_MS - this.clock.now();
    if (left <= 0) return true;
    this.arm("idle", left);
    return false;
  }

  /** `stream` closes at the call's end: an STT or speech stream, whose meter flushes then. */
  own(name: string, stream: Closable): void {
    this.#owned.push({ name, stream });
  }

  /** Closes every stream it owns; a failure is logged. */
  async close(): Promise<void> {
    await Promise.all(
      this.#owned.splice(0).map(({ name, stream }) =>
        stream.close().catch((error: unknown) => {
          logger.warning(`[voice] Closing ${name} failed: ${errorText(error)}`);
        }),
      ),
    );
  }
}
