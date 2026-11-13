import { type FetchLike, normalizeBaseUrl } from "../chat/client.ts";
import { isJsonObject } from "../chat/parse.ts";

export interface MemorySummary {
  readonly id: string;
  readonly memory: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}

export interface ListMemoriesResponse {
  readonly user_id: string;
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
  /** Bearer token (Login Sync token on public deployments, or admin secret). */
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

/** Lists the memories stored for `userId` (or for the Bearer token's viewer when omitted). */
export async function listMemories(
  options: MemoryRequestOptions & { readonly userId?: string },
): Promise<ListMemoriesResponse> {
  const query =
    options.userId === undefined ? "" : `?user_id=${encodeURIComponent(options.userId)}`;
  const res = await memoryRequest("GET", `/api/memories${query}`, options);
  const body: unknown = await res.json();
  if (!isJsonObject(body) || typeof body.user_id !== "string" || !Array.isArray(body.memories)) {
    throw new EidolonApiError(res.status, "Malformed memories response");
  }
  const memories: MemorySummary[] = body.memories.flatMap((item) =>
    isJsonObject(item) && typeof item.id === "string" && typeof item.memory === "string"
      ? [
          {
            id: item.id,
            memory: item.memory,
            ...(typeof item.created_at === "string" ? { created_at: item.created_at } : {}),
            ...(typeof item.updated_at === "string" ? { updated_at: item.updated_at } : {}),
          },
        ]
      : [],
  );
  return {
    user_id: body.user_id,
    count: typeof body.count === "number" ? body.count : memories.length,
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
