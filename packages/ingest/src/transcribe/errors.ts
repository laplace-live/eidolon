import type { EventCode } from "../progress.ts";

/**
 * A transcription that can't go ahead or didn't finish, with a message for the user, which the
 * CLI logs and exits 1 on, where any other error prints its stack.
 */
export class TranscribeError extends Error {
  override name = "TranscribeError";
  /** The event code a failed item carries, where one names the cause. */
  readonly code: EventCode | undefined;
  constructor(message: string, code?: EventCode) {
    super(message);
    this.code = code;
  }
}
