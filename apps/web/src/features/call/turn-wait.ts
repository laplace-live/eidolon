// The wait for her answer starts as the viewer's voice turn ends, but only for a turn with words
// in a final transcript: one without (a cough, noise) runs no LLM unless it cut her off, so nothing
// would end the wait (docs/frontend-loading-state.md). On a realtime model's call the turn ends
// before its transcript comes in, so that transcript starts the wait, unless she already answered.
import type { Watchdog } from "@laplace.live/eidolon-sdk";

export class TurnWait {
  readonly #watchdog: Pick<Watchdog, "arm" | "clear">;
  #worded = false;
  /** The turn ended before its words came in, and she hasn't answered yet. */
  #ended = false;

  constructor(watchdog: Pick<Watchdog, "arm" | "clear">) {
    this.#watchdog = watchdog;
  }

  /** The viewer started speaking: a new turn, and whatever she was answering is moot. */
  started(): void {
    this.#worded = false;
    this.#ended = false;
    this.#watchdog.clear();
  }

  heard(transcript: { readonly text: string; readonly final: boolean }): void {
    if (!transcript.final || transcript.text.trim() === "") return;
    this.#worded = true;
    if (this.#ended) {
      this.#ended = false;
      this.#watchdog.arm();
    }
  }

  stopped(): void {
    if (this.#worded) this.#watchdog.arm();
    else this.#ended = true;
  }

  /** She started answering, or an error ended the turn: a transcript after this starts no wait. */
  settled(): void {
    this.#ended = false;
    this.#watchdog.clear();
  }
}
