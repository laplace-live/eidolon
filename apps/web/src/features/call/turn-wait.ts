// The wait for her answer starts as the viewer's voice turn ends, but only for a turn with words
// in a final transcript: one without (a cough, noise) runs no LLM unless it cut her off, so nothing
// would end the wait (docs/frontend-loading-state.md).
import type { Watchdog } from "@laplace.live/eidolon-sdk";

export class TurnWait {
  readonly #watchdog: Pick<Watchdog, "arm" | "clear">;
  #worded = false;

  constructor(watchdog: Pick<Watchdog, "arm" | "clear">) {
    this.#watchdog = watchdog;
  }

  /** The viewer started speaking: a new turn, and whatever she was answering is moot. */
  started(): void {
    this.#worded = false;
    this.#watchdog.clear();
  }

  heard(transcript: { readonly text: string; readonly final: boolean }): void {
    if (transcript.final && transcript.text.trim() !== "") this.#worded = true;
  }

  stopped(): void {
    if (this.#worded) this.#watchdog.arm();
  }
}
