// The session's second half. Cookies ignore ports, so a service on another localhost port gets the
// session cookie too; the proof POST session answers with lives in this origin's localStorage,
// which no page on another port can read, and every API request sends it as a header.
import type { PROOF_HEADER } from "./api";

const HEADER: typeof PROOF_HEADER = "X-Eidolon-Proof";

/** Kept here as well, for a browser whose storage refuses it. */
let kept: string | null = null;

/** Per port, as the session cookie is named. */
function storageKey(): string {
  return `eidolon_proof_${globalThis.location?.port ?? ""}`;
}

/** Keeps the proof POST session answered with, for every later request and reload. */
export function keepProof(proof: string): void {
  kept = proof;
  try {
    globalThis.localStorage?.setItem(storageKey(), proof);
  } catch {
    // Storage is off, as in some private windows: the proof lasts until the page reloads.
  }
}

function storedProof(): string | null {
  try {
    return globalThis.localStorage?.getItem(storageKey()) ?? kept;
  } catch {
    return kept;
  }
}

/** The header an API request carries the proof in; none before a sign-in. */
export function proofHeaders(): Record<string, string> {
  const proof = storedProof();
  return proof === null ? {} : { [HEADER]: proof };
}
