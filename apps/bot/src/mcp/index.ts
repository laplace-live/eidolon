// The public read-only MCP server: search_persona_facts and search_streams over the two LanceDB
// indexes, as stateless Streamable HTTP with JSON responses. The app mounts `handle` at both /mcp
// and /mcp/, after CORS and the per-request idle-timeout opt-out. The bare path must answer
// directly: a redirect built behind a TLS-terminating proxy points at http://, a downgrade MCP SDK
// clients refuse to follow.
import {
  extractBearerToken,
  quotaFromEnv,
  resolveUserContext,
  type SlidingWindowQuota,
  type UserContext,
} from "@eidolon/access";
import { envOptional, logger } from "@eidolon/config";
import {
  openPersonaFactsRetriever,
  openStreamArchiveRetriever,
  personaFactsSearchParams,
  type Retriever,
  resolveDbPath,
  streamArchiveSearchParams,
} from "@eidolon/retrieval";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import {
  acceptsJson,
  bodyTooLargeResponse,
  checkTransportSecurity,
  type HostAllowlist,
  isExactJsonContentType,
  jsonRpcErrorResponse,
  notAMessageResponse,
  parseAllowedHosts,
  readBody,
} from "./http.ts";
import {
  type CallerTier,
  callTool,
  FACTS_INDEX_MISSING_NOTE,
  projectChunk,
  projectFact,
  SEARCH_PERSONA_FACTS,
  SEARCH_STREAMS,
  type SearchTool,
  STREAMS_INDEX_MISSING_NOTE,
  TOOL_DEFINITIONS,
} from "./tools.ts";

export interface McpHandler {
  /**
   * One stateless Streamable HTTP exchange; `clientIp` comes from access's resolveClientIp.
   * Never receives a CORS preflight: the app's route wrapper answers it first, because Bun hands
   * OPTIONS to function-valued routes instead of falling through to `fetch`.
   */
  handle(request: Request, clientIp: string): Promise<Response>;
}

export interface McpHandlerOptions {
  /** Default resolveDbPath(); ignored for injected retrievers. */
  readonly dbPath?: string;
  readonly personaFactsRetriever?: Pick<Retriever, "hasTable" | "search">;
  readonly streamArchiveRetriever?: Pick<Retriever, "hasTable" | "search">;
  readonly anonQuota?: SlidingWindowQuota;
  readonly authQuota?: SlidingWindowQuota;
  /** Default access's resolveUserContext. */
  readonly resolveUser?: (token: string) => Promise<UserContext>;
}

const SERVER_NAME = "laplace-eidolon";
const INSTRUCTIONS =
  "Retrieval over the streamer 明前奶绿's hand-compiled persona facts and past live-stream transcripts. Read-only.";
const CAPABILITIES: ServerCapabilities = {
  experimental: {},
  prompts: { listChanged: false },
  resources: { listChanged: false, subscribe: false },
  tools: { listChanged: false },
};

// Every search costs one embedding plus an optional rerank, so these cap spend; both tiers stay
// bounded.
const ANON_DEFAULT_PER_HOUR = 20;
const AUTH_DEFAULT_PER_HOUR = 120;
const DEFAULT_WINDOW_SEC = 3600;
const WINDOW_ENV = "EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC";

// Python's JSON parser rejects invalid UTF-8 and a leading BOM; a default decoder would replace
// the one and strip the other.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Deps {
  readonly tools: ReadonlyMap<string, SearchTool>;
  readonly anonQuota: SlidingWindowQuota;
  readonly authQuota: SlidingWindowQuota;
  readonly resolveUser: (token: string) => Promise<UserContext>;
  readonly allowlist: HostAllowlist | null;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Answered verbatim; McpError would prefix its message with "MCP error <code>: ". */
class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// A missing, blank, invalid or expired token is silently anonymous, never an error. Workers is
// asked only when a token is present, so the handshake and anonymous calls cost no round-trip.
async function resolveCallerTier(
  authorization: string | null,
  clientIp: string,
  deps: Deps,
): Promise<CallerTier> {
  const token = extractBearerToken(authorization);
  if (token !== null) {
    const user = await deps.resolveUser(token);
    if (user.isLoggedIn && user.mid !== null) {
      return { quota: deps.authQuota, key: String(user.mid), name: "authenticated" };
    }
  }
  return { quota: deps.anonQuota, key: clientIp, name: "anonymous" };
}

function buildServer(deps: Deps, tier: CallerTier): McpServer {
  const mcp = new McpServer(
    { name: SERVER_NAME, version: "" },
    { capabilities: CAPABILITIES, instructions: INSTRUCTIONS },
  );
  const { server } = mcp;
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOL_DEFINITIONS] }));
  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
  // tools/call is dispatched here rather than through setRequestHandler(CallToolRequestSchema),
  // whose zod parse answers malformed params, and `arguments: null` (which Python reads as {}),
  // with -32603 and the issue list.
  server.fallbackRequestHandler = async (request) => {
    if (request.method !== "tools/call") {
      throw new JsonRpcError(-32601, "Method not found", request.method);
    }
    const params: unknown = request.params;
    const args = isJsonObject(params) ? (params.arguments ?? {}) : null;
    if (!isJsonObject(params) || typeof params.name !== "string" || !isJsonObject(args)) {
      throw new JsonRpcError(-32602, "Invalid request parameters", "");
    }
    return callTool(deps.tools, params.name, args, tier);
  };
  return mcp;
}

async function dispatch(
  request: Request,
  message: JsonObject,
  deps: Deps,
  tier: CallerTier,
): Promise<Response> {
  // The SDK's JSON-response mode still 406s unless Accept lists both application/json and
  // text/event-stream, and its Content-Type parse rejects values the Python gates passed (e.g.
  // `application/json, text/plain`). Both were checked by Python's rules already.
  const headers = new Headers(request.headers);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  // A stateless transport serves exactly one request: the SDK throws "Stateless transport cannot
  // be reused across requests" on reuse.
  const mcp = buildServer(deps, tier);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  try {
    const forwarded = new Request(request.url, { method: "POST", headers });
    return await transport.handleRequest(forwarded, { parsedBody: message });
  } finally {
    await mcp.close();
  }
}

/** The Python server's checks in its order, which decides the error a malformed request gets. */
async function handle(request: Request, clientIp: string, deps: Deps): Promise<Response> {
  const body = await readBody(request);
  if (body === null) return bodyTooLargeResponse();
  const rejected = checkTransportSecurity(request, deps.allowlist);
  if (rejected !== null) return rejected;
  // No server-initiated message exists, so GET is 405, which the spec allows and the SDK client
  // reads as "no SSE stream". Python held a stream open that nothing is ever written to.
  if (request.method === "GET") {
    return jsonRpcErrorResponse(405, -32600, "Method Not Allowed", { allow: "POST" });
  }
  if (request.method === "DELETE") {
    return jsonRpcErrorResponse(
      405,
      -32600,
      "Method Not Allowed: Session termination not supported",
    );
  }
  if (request.method !== "POST") {
    return jsonRpcErrorResponse(405, -32600, "Method Not Allowed", { allow: "GET, POST, DELETE" });
  }
  if (!acceptsJson(request.headers.get("accept"))) {
    return jsonRpcErrorResponse(406, -32600, "Not Acceptable: Client must accept application/json");
  }
  if (!isExactJsonContentType(request.headers.get("content-type"))) {
    return jsonRpcErrorResponse(
      415,
      -32600,
      "Unsupported Media Type: Content-Type must be application/json",
    );
  }
  let message: unknown;
  try {
    message = JSON.parse(UTF8.decode(body));
  } catch {
    return jsonRpcErrorResponse(400, -32700, "Parse error: Invalid JSON");
  }
  // Python accepts no batches; the SDK would run an array of up to 100 messages.
  if (!isJsonObject(message)) return notAMessageResponse(message);
  // Python resolved the tier before any check; here a rejected request costs no Workers call.
  const tier = await resolveCallerTier(request.headers.get("authorization"), clientIp, deps);
  return dispatch(request, message, deps, tier);
}

/** Opens both retrievers and builds the per-tier quotas. Call after the .env load. */
export async function createMcpHandler(options: McpHandlerOptions = {}): Promise<McpHandler> {
  const dbPath = (): string => options.dbPath ?? resolveDbPath();
  const facts = options.personaFactsRetriever ?? (await openPersonaFactsRetriever(dbPath()));
  const streams = options.streamArchiveRetriever ?? (await openStreamArchiveRetriever(dbPath()));
  const tools = new Map<string, SearchTool>([
    [
      SEARCH_PERSONA_FACTS,
      {
        retriever: facts,
        params: personaFactsSearchParams(),
        missingNote: FACTS_INDEX_MISSING_NOTE,
        project: projectFact,
      },
    ],
    [
      SEARCH_STREAMS,
      {
        retriever: streams,
        params: streamArchiveSearchParams(),
        missingNote: STREAMS_INDEX_MISSING_NOTE,
        project: projectChunk,
      },
    ],
  ]);
  const anonQuota =
    options.anonQuota ??
    quotaFromEnv(
      "EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR",
      ANON_DEFAULT_PER_HOUR,
      WINDOW_ENV,
      DEFAULT_WINDOW_SEC,
    );
  const authQuota =
    options.authQuota ??
    quotaFromEnv(
      "EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR",
      AUTH_DEFAULT_PER_HOUR,
      WINDOW_ENV,
      DEFAULT_WINDOW_SEC,
    );
  const deps: Deps = {
    tools,
    anonQuota,
    authQuota,
    resolveUser: options.resolveUser ?? resolveUserContext,
    allowlist: parseAllowedHosts(envOptional("EIDOLON_MCP_ALLOWED_HOSTS")),
  };
  logger.info(
    `[mcp] Streamable HTTP server mounted at /mcp/ (anon ${anonQuota.maxPerWindow}/` +
      `${anonQuota.windowSeconds}s, auth ${authQuota.maxPerWindow}/${authQuota.windowSeconds}s)`,
  );
  return { handle: (request, clientIp) => handle(request, clientIp, deps) };
}
