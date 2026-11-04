// The response bytes Starlette and FastAPI produce for the Python bot, which clients already parse.

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
