/**
 * A transcription that can't go ahead or didn't finish, with a message for the user: Python's
 * RuntimeError, which the CLI logs and exits 1 on, where any other error prints a traceback.
 */
export class TranscribeError extends Error {
  override name = "TranscribeError";
}
