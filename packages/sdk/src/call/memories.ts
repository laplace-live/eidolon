import { type FetchLike, normalizeBaseUrl } from "../chat/client.ts";
import { isJsonObject } from "../chat/parse.ts";

export interface MemorySummary {
  readonly id: string;
  readonly memory: string;
  readonly categories?: readonly string[] | null;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface ListMemoriesResponse {
  readonly user_id: string;
  readonly uname?: string | null;
  readonly count: number;
  readonly memories: readonly MemorySummary[];
}

export interface ForgetMemoriesResponse {
  readonly ok: true;
  readonly user_id: string;
}

export class EidolonApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail ? `${status} · ${detail}` : `HTTP ${status}`);
    this.name = "EidolonApiError";
    this.status = status;
    this.detail = detail;
  }
}

export interface MemoryRequestOptions {
  readonly baseUrl: string;
  /** Login Sync Bearer token; `/api/memories` identifies the viewer solely from this token. */
  readonly token?: string;
  readonly headers?: HeadersInit;
  readonly credentials?: RequestCredentials;
  readonly signal?: AbortSignal;
  readonly fetch?: FetchLike;
}

function authHeaders(options: MemoryRequestOptions): Headers {
  const headers = new Headers(options.headers);
  const trimmed = options.token?.trim() ?? "";
  if (trimmed !== "" && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${trimmed}`);
  }
  return headers;
}

async function memoryRequest(
  method: "GET" | "POST",
  path: string,
  options: MemoryRequestOptions,
): Promise<Response> {
  const base = normalizeBaseUrl(options.baseUrl);
  const res = await (options.fetch ?? fetch)(`${base}${path}`, {
    method,
    headers: authHeaders(options),
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new EidolonApiError(res.status, text);
  }
  return res;
}

/** Lists the Mem0 memories stored for the signed-in viewer (`GET /api/memories`). */
export async function listMemories(
  options: MemoryRequestOptions & {
    /** @deprecated Ignored by `/api/memories`, which scopes exclusively to the Bearer token's viewer. */
    readonly userId?: string;
  },
): Promise<ListMemoriesResponse> {
  const res = await memoryRequest("GET", "/api/memories", options);
  const body: unknown = await res.json();
  if (!isJsonObject(body) || typeof body.user_id !== "string" || !Array.isArray(body.memories)) {
    throw new EidolonApiError(res.status, "Malformed memories response");
  }
  const memories: MemorySummary[] = body.memories.flatMap((item) => {
    if (!isJsonObject(item) || typeof item.id !== "string" || typeof item.memory !== "string") {
      return [];
    }
    const categories =
      item.categories === null
        ? null
        : Array.isArray(item.categories) && item.categories.every((c) => typeof c === "string")
          ? (item.categories as string[])
          : undefined;
    return [
      {
        id: item.id,
        memory: item.memory,
        ...(categories === undefined ? {} : { categories }),
        ...(typeof item.created_at === "string" ? { created_at: item.created_at } : {}),
        ...(typeof item.updated_at === "string" ? { updated_at: item.updated_at } : {}),
      },
    ];
  });
  const uname = typeof body.uname === "string" || body.uname === null ? body.uname : undefined;
  return {
    user_id: body.user_id,
    ...(uname === undefined ? {} : { uname }),
    count: memories.length,
    memories,
  };
}

/** Deletes every Mem0 memory stored for the signed-in viewer (`POST /api/memories/forget`). */
export async function forgetMemories(
  options: MemoryRequestOptions,
): Promise<ForgetMemoriesResponse> {
  const res = await memoryRequest("POST", "/api/memories/forget", options);
  const body: unknown = await res.json().catch(() => null);
  const userId = isJsonObject(body) && typeof body.user_id === "string" ? body.user_id : "";
  return { ok: true, user_id: userId };
}
