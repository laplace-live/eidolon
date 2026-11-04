// httpx's `Response.raise_for_status()` message, so a failed request greps the same as in the
// Python bot's log.

const STATUS_CLASSES: Readonly<Record<number, string>> = {
  1: "Informational response",
  3: "Redirect response",
  4: "Client error",
  5: "Server error",
};
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface HttpStatusReply {
  readonly status: number;
  readonly statusText: string;
  /** Read only for the redirect-location line. */
  readonly headers?: Headers;
}

export interface HttpxStatusOptions {
  /** Stop after the first line: no redirect location, no documentation link. */
  readonly statusLineOnly?: boolean;
  /** Print any non-empty Location header, where httpx requires a redirect status. */
  readonly anyLocation?: boolean;
  /** Keep the space before an empty reason phrase, as httpx's f-string does. */
  readonly spaceBeforeEmptyReason?: boolean;
}

/** The text of the `HTTPStatusError` that `raise_for_status()` raises for a non-2xx `reply`. */
export function httpxStatusMessage(
  reply: HttpStatusReply,
  url: string,
  options: HttpxStatusOptions = {},
): string {
  const { status, statusText } = reply;
  const kind = STATUS_CLASSES[Math.floor(status / 100)] ?? "Invalid status code";
  const reason = statusText || options.spaceBeforeEmptyReason ? ` ${statusText}` : "";
  const line = `${kind} '${status}${reason}' for url '${url}'`;
  if (options.statusLineOnly) return line;
  const location = reply.headers?.get("location") ?? null;
  const showLocation = options.anyLocation
    ? Boolean(location)
    : location !== null && REDIRECT_STATUSES.has(status);
  return (
    `${line}\n` +
    (showLocation ? `Redirect location: '${location}'\n` : "") +
    `For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${status}`
  );
}
