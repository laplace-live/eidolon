// The Soniox REST calls a transcription makes, over fetch: upload the audio, create a
// transcription, poll it, fetch the transcript, delete both. Every call retries network errors and
// the statuses Soniox calls retryable, with backoff.
import {
  abortableSleep,
  errorText,
  isPlainObject,
  loadsPy,
  logger,
  raceAbort,
} from "@eidolon/config";
import type { SonioxToken } from "./render.ts";

export const SONIOX_API_BASE = "https://api.soniox.com/v1";
// Python's httpx Timeout(600) is per phase, so a slow upload of a few hundred MB passes. Bun's
// `timeout` is the same idle timer; AbortSignal.timeout would cap the whole upload instead.
export const SONIOX_IDLE_TIMEOUT_MS = 600_000;
/** The waits before each retry: about a minute of flakiness ridden out, as Python's poll loop did. */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
// Soniox's error reference calls request timeouts, rate limits and server errors retryable.
const RETRY_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export class SonioxError extends Error {
  override name = "SonioxError";
}

/** Soniox answered with an error status, after any retries. */
export class SonioxApiError extends SonioxError {
  override name = "SonioxApiError";
  readonly status: number;
  /** Soniox's `error_type`, e.g. `transcription_invalid_state`. */
  readonly errorType: string | null;
  constructor(status: number, errorType: string | null, message: string) {
    super(message);
    this.status = status;
    this.errorType = errorType;
  }
}

/** No answer from Soniox, after every retry. */
export class SonioxConnectionError extends SonioxError {
  override name = "SonioxConnectionError";
}

/** An uploaded file. */
export interface SonioxFile {
  readonly id: string;
}

/** A transcription job; Soniox sends more, which nothing here reads. */
export interface SonioxTranscription {
  readonly id: string;
  readonly status: string;
  readonly filename: string | null;
  readonly audio_duration_ms: number | null;
  readonly created_at: string | null;
  readonly error_type: string | null;
  readonly error_message: string | null;
}

export interface SonioxTranscript {
  readonly id: string;
  readonly text: string;
  /** Parsed keeping Python's floats, so the payload writes `1.0` where Soniox sent it. */
  readonly tokens: readonly SonioxToken[];
}

export interface SonioxClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly retryDelaysMs?: readonly number[];
  /** Given the request's signal, which aborts the wait. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The SDK's `SonioxAPIError` text: Soniox's message, the status, any validation errors. */
function apiError(status: number, body: string): SonioxApiError {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON: the status alone says what went wrong.
  }
  const detail = isPlainObject(parsed) ? parsed : {};
  const errorType = text(detail.error_type);
  let message = text(detail.message) ?? text(detail.error_message) ?? (body.trim() || "error");
  message += ` (HTTP ${status}${errorType ? `, ${errorType}` : ""})`;
  const invalid = Array.isArray(detail.validation_errors) ? detail.validation_errors : [];
  if (invalid.length > 0) {
    const items = invalid.map((e) =>
      isPlainObject(e) ? `${String(e.location)}: ${String(e.message)}` : String(e),
    );
    message += ` Validation errors: ${items.join(", ")}`;
  }
  return new SonioxApiError(status, errorType, message);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

interface Send {
  readonly method: string;
  readonly path: string;
  readonly body?: () => BodyInit;
  readonly json?: unknown;
  /** A 404 means it is already gone, which is what a delete wanted. */
  readonly gone?: boolean;
  readonly signal?: AbortSignal | undefined;
}

export class SonioxClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #retryDelaysMs: readonly number[];
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: SonioxClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? SONIOX_API_BASE).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.#sleep = options.sleep ?? abortableSleep;
  }

  /** Uploads the audio as a multipart `file` named `filename`. */
  async upload(
    path: string,
    filename: string,
    clientReferenceId: string,
    signal?: AbortSignal,
  ): Promise<SonioxFile> {
    const body = await this.#send({
      method: "POST",
      path: "/files",
      // A fresh form per attempt: Bun.file is read lazily, so a retry streams the file again.
      body: () => {
        const form = new FormData();
        form.append("client_reference_id", clientReferenceId);
        form.append("file", Bun.file(path), filename);
        return form;
      },
      signal,
    });
    const file = JSON.parse(body) as Record<string, unknown>;
    return { id: String(file.id) };
  }

  async createTranscription(
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<SonioxTranscription> {
    return transcription(
      await this.#send({ method: "POST", path: "/transcriptions", json: payload, signal }),
    );
  }

  async getTranscription(id: string, signal?: AbortSignal): Promise<SonioxTranscription> {
    return transcription(
      await this.#send({ method: "GET", path: `/transcriptions/${id}`, signal }),
    );
  }

  async getTranscript(id: string, signal?: AbortSignal): Promise<SonioxTranscript> {
    const body = loadsPy(
      await this.#send({ method: "GET", path: `/transcriptions/${id}/transcript`, signal }),
    ) as Record<string, unknown>;
    return {
      id: String(body.id),
      text: text(body.text) ?? "",
      tokens: (Array.isArray(body.tokens) ? body.tokens : []) as SonioxToken[],
    };
  }

  /** One already gone counts as deleted. */
  async deleteTranscription(id: string, signal?: AbortSignal): Promise<void> {
    await this.#send({ method: "DELETE", path: `/transcriptions/${id}`, gone: true, signal });
  }

  /** One already gone counts as deleted. */
  async deleteFile(id: string, signal?: AbortSignal): Promise<void> {
    await this.#send({ method: "DELETE", path: `/files/${id}`, gone: true, signal });
  }

  async #send(request: Send): Promise<string> {
    const { method, path, signal } = request;
    const attempts = this.#retryDelaysMs.length + 1;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#apiKey}` };
    if (request.json !== undefined) headers["Content-Type"] = "application/json";
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      let status: number;
      let body: string;
      try {
        const response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method,
          headers,
          body: request.json !== undefined ? JSON.stringify(request.json) : request.body?.(),
          signal: signal ?? null,
          timeout: SONIOX_IDLE_TIMEOUT_MS,
        } as RequestInit);
        status = response.status;
        body = await response.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (attempt >= attempts) {
          throw new SonioxConnectionError(
            `Soniox ${method} ${path} failed ${attempts} times: ${describe(error)}`,
          );
        }
        await this.#retry(request, attempt, describe(error));
        continue;
      }
      if ((status >= 200 && status < 300) || (status === 404 && request.gone)) return body;
      const error = apiError(status, body);
      if (!RETRY_STATUSES.has(status) || attempt >= attempts) throw error;
      await this.#retry(request, attempt, errorText(error));
    }
  }

  async #retry(request: Send, attempt: number, reason: string): Promise<void> {
    const delay = this.#retryDelaysMs[attempt - 1] as number;
    logger.warning(
      `  Soniox ${request.method} ${request.path} failed (${attempt}/${this.#retryDelaysMs.length + 1}), ` +
        `retrying in ${delay / 1000}s: ${reason}`,
    );
    await raceAbort(this.#sleep(delay, request.signal), request.signal);
  }
}

function transcription(body: string): SonioxTranscription {
  const t = JSON.parse(body) as Record<string, unknown>;
  return {
    id: String(t.id),
    status: String(t.status),
    filename: text(t.filename),
    audio_duration_ms: typeof t.audio_duration_ms === "number" ? t.audio_duration_ms : null,
    created_at: text(t.created_at),
    error_type: text(t.error_type),
    error_message: text(t.error_message),
  };
}
