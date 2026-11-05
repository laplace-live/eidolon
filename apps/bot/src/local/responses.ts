// The local API's response bytes: compact JSON that no cache keeps, and one error shape.
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

/** The body as UTF-8 text, or null once it passes `limit` bytes, counted while it streams. */
export async function readText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return "";
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
  return new TextDecoder().decode(Buffer.concat(chunks));
}
