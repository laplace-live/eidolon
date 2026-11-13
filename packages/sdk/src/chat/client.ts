import { isAttachmentName, isJsonObject, parseStreamLine } from "./parse.ts";
import type { ChatStreamLine, ChatWindow } from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A request the chat endpoint refused, or one that never got an answer. */
export class ChatRequestError extends Error {
  /** 0 when no answer came. */
  readonly status: number;
  /**
   * The server's code (`bad-request`, `persona-not-served`, `payload-too-large`,
   * `unsupported-media-type`, `upstream-failed`, `unavailable`…), else `rate-limited` for a 429,
   * `network`, `bad-stream`, `timeout` (a file only), or `http-<status>`.
   */
  readonly code: string;
  /** Seconds to wait, on a 429. */
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = "ChatRequestError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** `baseUrl` without trailing slashes or surrounding space. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end--;
  return end === trimmed.length ? trimmed : trimmed.slice(0, end);
}

async function request(fetcher: FetchLike, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (error) {
    if (init.signal?.aborted || isAbortError(error)) throw error;
    throw new ChatRequestError(
      0,
      "network",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function retryAfterOf(body: unknown, header: string | null): number | null {
  const fromBody = isJsonObject(body) ? body.retry_after : undefined;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  const trimmed = header?.trim() ?? "";
  const fromHeader = trimmed === "" ? Number.NaN : Number(trimmed);
  return Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : null;
}

/** The error a refused answer carries: `{ error: { code, message } }`, or a 429's `{ error, retry_after }`. */
async function refusalOf(res: Response): Promise<ChatRequestError> {
  let body: unknown = null;
  try {
    body = JSON.parse(await res.text());
  } catch {
    // A proxy's page, or no body at all.
  }
  const error = isJsonObject(body) ? body.error : undefined;
  if (res.status === 429) {
    const message = typeof error === "string" ? error : "Too many requests";
    return new ChatRequestError(
      429,
      "rate-limited",
      message,
      retryAfterOf(body, res.headers.get("retry-after")),
    );
  }
  if (isJsonObject(error)) {
    const { code, message } = error;
    if (typeof code === "string" && typeof message === "string") {
      return new ChatRequestError(res.status, code, message);
    }
  }
  return new ChatRequestError(
    res.status,
    `http-${res.status}`,
    res.statusText || `HTTP ${res.status}`,
  );
}

function jsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new ChatRequestError(200, "bad-stream", "A line of the answer is not JSON");
  }
}

/** Each JSON value of an NDJSON body. Leaving early cancels the body, which aborts her reply. */
async function* ndjsonValues(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (!finished) {
      const { done, value } = await reader.read();
      finished = done;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let start = 0;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(start, newline);
        start = newline + 1;
        if (line.trim() !== "") yield jsonLine(line);
        newline = buffer.indexOf("\n", start);
      }
      if (start > 0) buffer = buffer.slice(start);
    }
    if (buffer.trim() !== "") yield jsonLine(buffer);
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
  }
}

/** A turn's stream lines; lines of a type this client doesn't know are skipped. */
async function* streamLines(res: Response): AsyncGenerator<ChatStreamLine, void, undefined> {
  if (!res.ok) throw await refusalOf(res);
  if (res.body === null) {
    throw new ChatRequestError(res.status, "bad-stream", "The answer has no body");
  }
  const openTurns = new Set<string>();
  let sawTerminalError = false;
  for await (const value of ndjsonValues(res.body)) {
    const line = parseStreamLine(value);
    if (line === null) continue;
    if (line.type === "started") openTurns.add(line.turn);
    else if (line.type === "ended") openTurns.delete(line.turn);
    else if (line.type === "error") {
      sawTerminalError = true;
      openTurns.clear();
    }
    yield line;
  }
  if (!sawTerminalError && openTurns.size > 0) {
    throw new ChatRequestError(
      res.status,
      "bad-stream",
      "The answer ended before her turn finished",
    );
  }
}

export type ChatAvailability = "on" | "off" | "unreachable";

/**
 * Whether `baseUrl` serves the chat endpoint. While off, every `/api/chat/*` path answers 404;
 * while on, the turn route answers a GET with 405. Anything else, or no answer, is `unreachable`.
 */
export async function probeChatEndpoint(
  baseUrl: string,
  options: { readonly fetch?: FetchLike } = {},
): Promise<ChatAvailability> {
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(`${normalizeBaseUrl(baseUrl)}/api/chat/turn`, {
      method: "GET",
      cache: "no-store",
    });
  } catch {
    return "unreachable";
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 405) return "on";
  if (res.status === 404) return "off";
  return "unreachable";
}

/** `probeChatEndpoint` cached per base URL; an `unreachable` answer is asked again next time. */
export function createChatAvailability(
  options: { readonly fetch?: FetchLike } = {},
): (baseUrl: string) => Promise<ChatAvailability> {
  const known = new Map<string, Promise<ChatAvailability>>();
  return (baseUrl) => {
    const key = normalizeBaseUrl(baseUrl);
    const cached = known.get(key);
    if (cached !== undefined) return cached;
    const probe = probeChatEndpoint(key, options).then(
      (availability) => {
        if (availability === "unreachable") known.delete(key);
        return availability;
      },
      (error: unknown) => {
        known.delete(key);
        throw error;
      },
    );
    known.set(key, probe);
    return probe;
  };
}

/** Process-wide availability probe cache, one probe per normalized base URL. */
export const chatAvailability = createChatAvailability();

export interface TurnRequest {
  readonly baseUrl: string;
  readonly chat: ChatWindow;
  /** The viewer's line (see `chatTextOf`); absent asks for her greeting in a new chat of one. */
  readonly text?: string;
  /** The Login Sync token a call sends; absent or blank is anonymous. */
  readonly loginSyncToken?: string | null;
  readonly signal?: AbortSignal;
  readonly fetch?: FetchLike;
}

function tokenOf(token: string | null | undefined): string | null {
  const trimmed = token?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Streams a turn's NDJSON lines as they arrive. Rejects with `ChatRequestError` when refused;
 * stopping early cancels the stream and aborts her reply.
 */
export async function* streamTurn(
  turn: TurnRequest,
): AsyncGenerator<ChatStreamLine, void, undefined> {
  const token = tokenOf(turn.loginSyncToken);
  const body = {
    chat: turn.chat,
    ...(turn.text === undefined ? {} : { text: turn.text }),
    ...(token === null ? {} : { loginSyncToken: token }),
  };
  const res = await request(
    turn.fetch ?? fetch,
    `${normalizeBaseUrl(turn.baseUrl)}/api/chat/turn`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: turn.signal,
    },
  );
  yield* streamLines(res);
}

export type VoiceRequest = Omit<TurnRequest, "text"> & {
  /** The recording, typed audio/webm, audio/ogg, audio/mp4 or audio/mpeg, codecs allowed. */
  readonly audio: Blob;
  /** The recorder's clock. */
  readonly durationMs: number;
};

/**
 * Streams a voice turn's NDJSON lines; its first `events` line holds the viewer's voice message
 * with its transcript and the attachment name its audio is kept under.
 */
export async function* streamVoice(
  voice: VoiceRequest,
): AsyncGenerator<ChatStreamLine, void, undefined> {
  const form = new FormData();
  form.append("chat", JSON.stringify(voice.chat));
  form.append("audio", voice.audio);
  form.append("durationMs", String(Math.max(1, Math.round(voice.durationMs))));
  const token = tokenOf(voice.loginSyncToken);
  if (token !== null) form.append("loginSyncToken", token);
  const res = await request(
    voice.fetch ?? fetch,
    `${normalizeBaseUrl(voice.baseUrl)}/api/chat/voice`,
    {
      method: "POST",
      body: form,
      signal: voice.signal,
    },
  );
  yield* streamLines(res);
}

/** How long one of her files may take, body included, before a turn goes on without it. */
export const FILE_TIMEOUT_MS = 30_000;

/**
 * Fetches her selfie or voice reply by attachment name, or null once it has expired on the server.
 * Rejects with `ChatRequestError` on other failures, `timeout` past `FILE_TIMEOUT_MS`, or an
 * invalid attachment name.
 */
export async function fetchChatFile(file: {
  readonly baseUrl: string;
  readonly name: string;
  readonly fetch?: FetchLike;
}): Promise<Blob | null> {
  if (!isAttachmentName(file.name)) {
    throw new ChatRequestError(0, "bad-request", `${file.name} isn't a file's name`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);
  try {
    const url = `${normalizeBaseUrl(file.baseUrl)}/api/chat/files/${file.name}`;
    const res = await request(file.fetch ?? fetch, url, { signal: controller.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw await refusalOf(res);
    return await res.blob();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ChatRequestError(0, "timeout", `${file.name} didn't arrive in time`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
