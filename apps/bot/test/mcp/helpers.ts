// Shared fixtures for the MCP tests: tests/test_mcp_server.py's fakes.
import { afterAll, beforeAll } from "bun:test";
import { SlidingWindowQuota, type UserContext } from "@eidolon/access";
import type { Retriever, SearchOptions, SearchRow } from "@eidolon/retrieval";
import { createMcpHandler, type McpHandler, type McpHandlerOptions } from "../../src/mcp/index.ts";

export const FACT_HIT: SearchRow = {
  text: "她喜欢喝奶茶",
  date: "2025-05-09",
  source: "设定集",
  _relevance_score: 0.92,
  vector: [0.1, 0.2],
};

export const CHUNK_HIT: SearchRow = {
  stream_date: "2025-05-09",
  details: "聊了新游戏",
  summary: "游戏",
  text: "raw transcript",
  topics: JSON.stringify(["游戏", "杂谈"]),
  _relevance_score: 0.81,
  vector: [0.3],
};

export const ACCEPT = "application/json, text/event-stream";

/** Stand-in for LanceRetriever: `hasTable: false` mimics a missing index. */
export class FakeRetriever implements Pick<Retriever, "hasTable" | "search"> {
  readonly hasTable: boolean;
  readonly calls: { query: string; options: SearchOptions }[] = [];
  readonly #search: () => Promise<SearchRow[]>;

  constructor(
    hits: SearchRow[],
    options: { hasTable?: boolean; search?: () => Promise<SearchRow[]> } = {},
  ) {
    this.hasTable = options.hasTable ?? true;
    this.#search = options.search ?? (async () => hits);
  }

  search(query: string, options: SearchOptions): Promise<SearchRow[]> {
    this.calls.push({ query, options });
    return this.#search();
  }
}

export interface BuildOptions {
  readonly anonMax?: number;
  readonly authMax?: number;
  readonly facts?: FakeRetriever;
  readonly streams?: FakeRetriever;
  readonly resolveUser?: (token: string) => Promise<UserContext>;
}

export function buildHandler(options: BuildOptions = {}): Promise<McpHandler> {
  const handlerOptions: McpHandlerOptions = {
    personaFactsRetriever: options.facts ?? new FakeRetriever([FACT_HIT]),
    streamArchiveRetriever: options.streams ?? new FakeRetriever([CHUNK_HIT]),
    anonQuota: new SlidingWindowQuota(options.anonMax ?? 5, 3600),
    authQuota: new SlidingWindowQuota(options.authMax ?? 50, 3600),
    ...(options.resolveUser ? { resolveUser: options.resolveUser } : {}),
  };
  return createMcpHandler(handlerOptions);
}

export interface RpcOptions {
  readonly id?: number | null;
  readonly token?: string;
  readonly path?: string;
  readonly clientIp?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export function rpc(
  handler: McpHandler,
  method: string,
  params?: unknown,
  options: RpcOptions = {},
): Promise<Response> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  const id = options.id === undefined ? 1 : options.id;
  if (id !== null) body.id = id;
  const headers = new Headers({ "content-type": "application/json", accept: ACCEPT });
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const request = new Request(`http://localhost${options.path ?? "/mcp/"}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return handler.handle(request, options.clientIp ?? "testclient");
}

export function callTool(
  handler: McpHandler,
  name: string,
  args: Record<string, unknown> = {},
  options: RpcOptions = {},
): Promise<Response> {
  return rpc(handler, "tools/call", { name, arguments: args }, options);
}

/** The JSON-RPC `result`, untyped: tests assert it field by field. */
export async function resultOf(response: Promise<Response> | Response): Promise<any> {
  const body = (await (await response).json()) as { result?: unknown; error?: unknown };
  if (body.result === undefined) throw new Error(`no result: ${JSON.stringify(body)}`);
  return body.result;
}

const ISOLATED_ENV = [
  "EIDOLON_MCP_ALLOWED_HOSTS",
  "EIDOLON_MCP_ANON_RATE_LIMIT_PER_HOUR",
  "EIDOLON_MCP_AUTH_RATE_LIMIT_PER_HOUR",
  "EIDOLON_MCP_RATE_LIMIT_WINDOW_SEC",
  "PERSONA_FACTS_CANDIDATES",
  "STREAM_ARCHIVE_CANDIDATES",
  "WORKERS_BASE_URL",
  "LANCEDB_PATH",
] as const;

/** Clears the env the handler reads for this file, restoring the caller's values afterwards. */
export function isolateEnv(): void {
  const saved = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const name of ISOLATED_ENV) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** Runs `body` with `vars` set, then puts the previous values back. */
export async function withEnv<T>(
  vars: Readonly<Record<string, string>>,
  body: () => Promise<T>,
): Promise<T> {
  const previous = Object.keys(vars).map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
