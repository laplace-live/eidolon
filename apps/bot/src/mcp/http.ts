// The Python server's HTTP-level checks, with its response bodies: TransportSecurityMiddleware,
// RequestBodyLimitMiddleware and the streamable-HTTP transport's own gates.
import { logger, pyStrip } from "@eidolon/config";
import { validationErrorText } from "./pydantic.ts";

/** RequestBodyLimitMiddleware's default. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MESSAGE_MODELS = ["JSONRPCRequest", "JSONRPCNotification", "JSONRPCResponse", "JSONRPCError"];

export interface HostAllowlist {
  readonly hosts: readonly string[];
  readonly origins: readonly string[];
}

/**
 * `EIDOLON_MCP_ALLOWED_HOSTS`: null when blank, which turns the Host/Origin check off so the
 * reverse proxy owns it and a fresh checkout stays reachable on localhost. Origins are every host
 * over https, then every host over http; an entry may end in `:*` to allow any port.
 */
export function parseAllowedHosts(raw: string | undefined): HostAllowlist | null {
  const text = pyStrip(raw ?? "");
  if (!text) return null;
  const hosts = text
    .split(",")
    .map((h) => pyStrip(h))
    .filter((h) => h !== "");
  return {
    hosts,
    origins: [...hosts.map((h) => `https://${h}`), ...hosts.map((h) => `http://${h}`)],
  };
}

function isAllowed(value: string, allowed: readonly string[]): boolean {
  if (allowed.includes(value)) return true;
  return allowed.some(
    (entry) => entry.endsWith(":*") && value.startsWith(`${entry.slice(0, -2)}:`),
  );
}

/**
 * Checked here, not through the SDK's `allowedHosts` option: that option is deprecated and answers
 * a bad Host with 403, where the Python server answers 421.
 */
export function checkTransportSecurity(
  request: Request,
  allowlist: HostAllowlist | null,
): Response | null {
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type");
    if (contentType === null || !contentType.toLowerCase().startsWith("application/json")) {
      return new Response("Invalid Content-Type header", { status: 400 });
    }
  }
  if (allowlist === null) return null;
  const host = request.headers.get("host");
  if (!host || !isAllowed(host, allowlist.hosts)) {
    logger.warning(
      host ? `[mcp] Invalid Host header: ${host}` : "[mcp] Missing Host header in request",
    );
    return new Response("Invalid Host header", { status: 421 });
  }
  const origin = request.headers.get("origin");
  if (origin && !isAllowed(origin, allowlist.origins)) {
    logger.warning(`[mcp] Invalid Origin header: ${origin}`);
    return new Response("Invalid Origin header", { status: 403 });
  }
  return null;
}

/** The JSON-response-mode Accept rule: `application/json`, `application/*` or `*\/*`; q ignored. */
export function acceptsJson(accept: string | null): boolean {
  return (accept ?? "").split(",").some((part) => {
    const type = pyStrip(pyStrip(part).split(";")[0] as string).toLowerCase();
    return type === "application/json" || type === "application/*" || type === "*/*";
  });
}

/** The transport's second Content-Type gate: a `;`-then-`,` split part exactly `application/json`. */
export function isExactJsonContentType(contentType: string | null): boolean {
  const essence = (contentType ?? "").split(";")[0] as string;
  return essence.split(",").some((part) => pyStrip(part) === "application/json");
}

export function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  headers?: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The body's bytes, or null past the limit; a declared Content-Length over it is refused unread. */
export async function readBody(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function bodyTooLargeResponse(): Response {
  return new Response("Request body too large", { status: 413 });
}

/** A body that is JSON but not an object, a batch array included: pydantic's union error. */
export function notAMessageResponse(value: unknown): Response {
  const errors = MESSAGE_MODELS.map((model) => ({
    loc: model,
    type: "model_type",
    message: `Input should be a valid dictionary or instance of ${model}`,
    input: value,
  }));
  const text = validationErrorText(`union[${MESSAGE_MODELS.join(",")}]`, errors);
  return jsonRpcErrorResponse(400, -32602, `Validation error: ${text}`);
}
