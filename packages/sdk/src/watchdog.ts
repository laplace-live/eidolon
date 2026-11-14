// Post-utterance wait timers: "thinking" appears only once a pause is noticeable so fast replies
// never flicker it; "stuck" means `bot-llm-started` has not arrived at all.

/** Delay before showing the thinking indicator after a viewer turn finishes. */
export const THINKING_DELAY_MS = 600;

/** Delay without `bot-llm-started` before surfacing a stalled-pipeline hint. */
export const STUCK_DELAY_MS = 8000;

export interface WaitState {
  readonly thinking: boolean;
  readonly stuck: boolean;
}

export interface Scheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Watchdog {
  readonly #onChange: (state: WaitState) => void;
  readonly #scheduler: Scheduler;
  #thinkingTimer: unknown = null;
  #stuckTimer: unknown = null;
  #state: WaitState = { thinking: false, stuck: false };

  constructor(onChange: (state: WaitState) => void, scheduler: Scheduler = defaultScheduler) {
    this.#onChange = onChange;
    this.#scheduler = scheduler;
  }

  get state(): WaitState {
    return this.#state;
  }

  /** Arms both timers when the viewer finishes speaking or submits typed text. */
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

  /** Cancels the stuck timer once `bot-llm-started` proves the pipeline is alive. */
  llmStarted(): void {
    this.#cancel("stuck");
    this.#update({ stuck: false });
  }

  /** Resets both timers when speech starts, the viewer barges in, an error arrives, or the call ends. */
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
