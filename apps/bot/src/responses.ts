// The response bytes Starlette and FastAPI produce, which clients already parse, and the request
// body reader the local and chat routes share.

/** Starlette `JSONResponse`: compact separators, raw UTF-8, `application/json` with no charset. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** FastAPI's answer to a known path with the wrong method. */
export function methodNotAllowed(allow: string): Response {
  return jsonResponse(405, { detail: "Method Not Allowed" }, { allow });
}

/** FastAPI's answer to an unknown path. */
export function notFound(): Response {
  return jsonResponse(404, { detail: "Not Found" });
}

/** Starlette's plain-text error body, as `ServerErrorMiddleware` and mounted routers send it. */
export function plainText(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** The 500 for an uncaught error; the error itself is only logged. */
export function internalServerError(): Response {
  return plainText(500, "Internal Server Error");
}

/** The body's bytes, or null once it passes `limit` bytes, counted while it streams. */
export async function readBytes(request: Request, limit: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return Buffer.alloc(0);
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
