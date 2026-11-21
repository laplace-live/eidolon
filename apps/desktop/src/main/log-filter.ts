// What main logs of the backend's output. Two stdout lines hold a link code that signs a browser
// in, and main never logs either; whoever reads the lines still sees them first.
import type { Readable } from "node:stream";

/** boot.ts's line once a server listens. */
export const READY_LINE = "Eidolon is ready:";
/** boot.ts's line for a start that found this data home's server on the port it asked for. */
export const ALREADY_RUNNING_LINE = "Eidolon is already running:";

// A link code anywhere, as the link's fragment: #<unix seconds>.<43 base64url characters>.
const LINK_CODE = /#\d{1,12}\.[A-Za-z0-9_-]{43}/;

/** A line that long with no newline yet is passed on in pieces. */
const MAX_LINE = 64 * 1024;

export function holdsLinkCode(line: string): boolean {
  return line.includes(READY_LINE) || line.includes(ALREADY_RUNNING_LINE) || LINK_CODE.test(line);
}

/**
 * Reads `stream` line by line until it ends: `read` sees every line, `log` only those without a
 * link code.
 */
export function filterLines(
  stream: Readable | null,
  read: (line: string) => void,
  log: (line: string) => void,
): Promise<void> {
  if (stream === null) return Promise.resolve();
  return new Promise((resolve) => {
    let pending = "";
    let ended = false;
    const emit = (raw: string): void => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      read(line);
      if (!holdsLinkCode(line)) log(line);
    };
    const end = (): void => {
      if (ended) return;
      ended = true;
      if (pending !== "") emit(pending);
      pending = "";
      resolve();
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      pending += chunk;
      for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
        emit(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      while (pending.length > MAX_LINE) {
        emit(pending.slice(0, MAX_LINE));
        pending = pending.slice(MAX_LINE);
      }
    });
    stream.once("end", end);
    stream.once("close", end);
    stream.once("error", end);
  });
}
