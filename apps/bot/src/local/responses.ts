// The local API's response bytes: compact JSON that no cache keeps, and one error shape.
import { randomBytes } from "node:crypto";
import { logger } from "@eidolon/config";
import type { ErrorBody, ErrorCode } from "./api.ts";

export const NO_STORE = "no-store";

export function localJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": NO_STORE, ...headers },
  });
}

/** `{error: {code, message}}`: the SPA shows its own string for the code, the message as detail. */
export function localError(
  status: number,
  code: ErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  const body: ErrorBody = { error: { code, message } };
  return localJson(status, body, headers);
}

/**
 * A 5xx: its code and a fixed message, never the exception's text or stack. `log` writes the
 * details under a short id, which the answer carries so a report can be matched to its log line.
 */
export function localFailure(
  status: number,
  code: ErrorCode,
  message: string,
  log: (id: string) => void,
): Response {
  const id = randomBytes(4).toString("hex");
  log(id);
  const body: ErrorBody = { error: { code, message, id } };
  return localJson(status, body);
}

/** The 500 for a request that threw, logged with its stack. */
export function internalError(request: Request, error: unknown): Response {
  return localFailure(500, "internal", "Eidolon hit an error; the terminal has the details", (id) =>
    logger.exception(
      `${request.method} ${new URL(request.url).pathname} failed (error ${id})`,
      error,
    ),
  );
}

/** JSON request bodies are small; anything bigger is refused before it is parsed. */
export const JSON_BODY_LIMIT = 1024 * 1024;

/**
 * The request's JSON body, or the 400 or 413 to answer instead. A parse error is reported
 * without its text, which would echo the body back.
 */
export async function readJson(
  request: Request,
  limit = JSON_BODY_LIMIT,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const text = await readText(request, limit);
  if (text === null) {
    return { ok: false, response: localError(413, "payload-too-large", "The body is too large") };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: localError(400, "bad-json", "The body is not valid JSON") };
  }
}

/** The body's bytes, or null once it passes `limit` bytes, counted while it streams. */
export async function readBytes(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The body as UTF-8 text, or null once it passes `limit` bytes. */
export async function readText(request: Request, limit: number): Promise<string | null> {
  const bytes = await readBytes(request, limit);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
