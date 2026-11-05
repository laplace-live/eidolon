// The wait between the viewer's turn and the bot's answer. "Thinking" shows only once the wait is
// noticeable, so fast answers never flicker it; "stuck" means no sign of the pipeline at all.

/** Long enough that a quick answer never shows the thinking dots. */
export const THINKING_DELAY_MS = 600;

/**
 * `bot-llm-started` goes out before the LLM request does, so a turn that hasn't produced it this
 * long after it ended usually means the STT never finalized.
 */
export const STUCK_DELAY_MS = 8000;

export interface WaitState {
  readonly thinking: boolean;
  readonly stuck: boolean;
}

export interface Scheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserScheduler: Scheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Watchdog {
  readonly #onChange: (state: WaitState) => void;
  readonly #scheduler: Scheduler;
  #thinkingTimer: unknown = null;
  #stuckTimer: unknown = null;
  #state: WaitState = { thinking: false, stuck: false };

  constructor(onChange: (state: WaitState) => void, scheduler: Scheduler = browserScheduler) {
    this.#onChange = onChange;
    this.#scheduler = scheduler;
  }

  /** The viewer finished a turn, by voice or by typing; a turn still waiting starts over. */
  arm(): void {
    this.clear();
    this.#thinkingTimer = this.#scheduler.set(() => {
      this.#thinkingTimer = null;
      this.#update({ thinking: true });
    }, THINKING_DELAY_MS);
    this.#stuckTimer = this.#scheduler.set(() => {
      this.#stuckTimer = null;
      this.#update({ stuck: true });
    }, STUCK_DELAY_MS);
  }

  /** The LLM started: the pipeline is alive, though the answer is still on its way. */
  llmStarted(): void {
    this.#cancel("stuck");
    this.#update({ stuck: false });
  }

  /** The bot started speaking, the viewer barged in, an error came, or the call ended. */
  clear(): void {
    this.#cancel("thinking");
    this.#cancel("stuck");
    this.#update({ thinking: false, stuck: false });
  }

  #cancel(which: "thinking" | "stuck"): void {
    const timer = which === "thinking" ? this.#thinkingTimer : this.#stuckTimer;
    if (timer !== null) this.#scheduler.clear(timer);
    if (which === "thinking") this.#thinkingTimer = null;
    else this.#stuckTimer = null;
  }

  #update(change: Partial<WaitState>): void {
    const next = { ...this.#state, ...change };
    if (next.thinking === this.#state.thinking && next.stuck === this.#state.stuck) return;
    this.#state = next;
    this.#onChange(next);
  }
}
