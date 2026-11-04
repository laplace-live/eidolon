import { envOptional, envRaw, logger, openrouterHeaders, pyRepr, pyStrip } from "@eidolon/config";

export const DEFAULT_RERANK_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_RERANK_MODEL = "cohere/rerank-4-fast";
export const RERANK_TIMEOUT_SEC = 10;

// OpenRouter's rerank route 429s on roughly half its calls whatever the
// pacing: 3/8 from a cold minute on 2026-09-07, where the same Cohere key
// called directly went 8/8. Outcomes are independent rather than a rate
// window — successes and failures interleave one call apart — so an
// immediate retry is worth more than a backoff, and three attempts take
// ~50% up to ~90%. Rejections come back in ~400ms (vs ~450ms for a success),
// which is what bounds the worst case here.
export const RERANK_MAX_ATTEMPTS = 3;

export interface RerankResult {
  /** Index into the documents sent. */
  readonly index: number;
  readonly relevanceScore: number | null;
}

export interface Reranker {
  readonly modelName: string;
  /** The row field sent as each document. */
  readonly column: string;
  /** Results best first, as the provider ranked them. */
  rerank(
    query: string,
    documents: readonly unknown[],
    options?: { signal?: AbortSignal },
  ): Promise<RerankResult[]>;
}

export interface OpenRouterRerankerOptions {
  apiKey: string;
  modelName?: string;
  column?: string;
  /** null leaves `top_n` out of the request. */
  topN?: number | null;
  /** A trailing "/" is stripped. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

const ERROR_KINDS: Record<number, string> = {
  1: "Informational response",
  3: "Redirect response",
  4: "Client error",
  5: "Server error",
};

interface Reply {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: ArrayBuffer;
}

/** httpx's `raise_for_status` message. */
function statusError(response: Reply, url: string): Error {
  const kind = ERROR_KINDS[Math.floor(response.status / 100)] ?? "Invalid status code";
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const location = response.headers.get("location");
  return new Error(
    `${kind} '${status}' for url '${url}'\n` +
      (location ? `Redirect location: '${location}'\n` : "") +
      `For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${response.status}`,
  );
}

function parseResults(payload: unknown, count: number): RerankResult[] {
  if (typeof payload !== "object" || payload === null || !("results" in payload)) {
    throw new Error(pyRepr("results"));
  }
  const { results } = payload as { results: unknown };
  if (!Array.isArray(results)) throw new TypeError("rerank results are not a list");
  return results.map((entry: unknown) => {
    const { index, relevance_score: score } = (entry ?? {}) as Record<string, unknown>;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError(`Index ${pyRepr(index)} out of bounds`);
    }
    if (score !== null && typeof score !== "number") {
      throw new TypeError(`Could not convert ${pyRepr(score)} to float32`);
    }
    return { index, relevanceScore: score };
  });
}

/**
 * Cohere's rerank models through OpenRouter's `/rerank` route. OpenRouter mirrors Cohere's rerank
 * request and response bodies, so `RERANK_BASE_URL=https://api.cohere.com/v1` works too.
 */
export class OpenRouterReranker implements Reranker {
  readonly modelName: string;
  readonly column: string;
  readonly topN: number | null;
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch | null;

  constructor(options: OpenRouterRerankerOptions) {
    this.modelName = options.modelName ?? DEFAULT_RERANK_MODEL;
    this.column = options.column ?? "text";
    this.topN = options.topN ?? null;
    this.baseUrl = (options.baseUrl ?? DEFAULT_RERANK_BASE_URL).replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? null;
  }

  async rerank(
    query: string,
    documents: readonly unknown[],
    options: { signal?: AbortSignal } = {},
  ): Promise<RerankResult[]> {
    if (documents.length === 0) return [];
    const payload: Record<string, unknown> = { model: this.modelName, query, documents };
    if (this.topN !== null) payload.top_n = this.topN;
    const init = {
      method: "POST",
      headers: {
        ...openrouterHeaders(),
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      // httpx doesn't follow redirects, so a 3xx is a failure there too.
      redirect: "manual",
    } satisfies RequestInit;
    const url = `${this.baseUrl}/rerank`;
    const post = async (): Promise<Reply> => {
      const timeout = AbortSignal.timeout(RERANK_TIMEOUT_SEC * 1000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      try {
        const response = await (this.#fetch ?? fetch)(url, { ...init, signal });
        // Read inside the timeout, as httpx's read timeout covers the body.
        const body = await response.arrayBuffer();
        const { status, statusText, headers } = response;
        return { status, statusText, headers, body };
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (timeout.aborted) throw new Error("timed out");
        throw error;
      }
    };
    let response = await post();
    for (let attempt = 1; attempt < RERANK_MAX_ATTEMPTS; attempt++) {
      if (response.status !== 429) break;
      logger.debug(`Rerank 429 on attempt ${attempt}; retrying immediately`);
      response = await post();
    }
    if (response.status < 200 || response.status >= 300) throw statusError(response, url);
    return parseResults(JSON.parse(new TextDecoder().decode(response.body)), documents.length);
  }
}

const RERANK_OFF = new Set(["false", "0", "no", "off"]);
let cached: { reranker: Reranker | null } | null = null;

/**
 * The process's cross-encoder reranker, or null when switched off; the first call fixes it. With
 * null, hybrid search fuses the legs with RRF, which beat LinearCombinationReranker throughout
 * our eval: its score normalisation ties the top results and randomises their order.
 * `cohere/rerank-4-fast` reads query and candidate together, so it catches intent no score
 * combiner can, at $0.002 per search unit on the same OpenRouter account.
 */
export function makeReranker(model?: string | null): Reranker | null {
  if (cached !== null) return cached.reranker;
  cached = { reranker: null };
  if (RERANK_OFF.has(pyStrip(envRaw("RERANK_ENABLED") ?? "").toLowerCase())) {
    logger.info("RERANK_ENABLED is off — hybrid retrieval will use RRF fusion");
    return null;
  }
  const apiKey = envOptional("RERANK_API_KEY") ?? envOptional("OPENROUTER_API_KEY");
  if (apiKey === undefined) {
    logger.info(
      "Neither RERANK_API_KEY nor OPENROUTER_API_KEY is set — hybrid " +
        "retrieval will use LanceDB's default RRF fusion (no " +
        "cross-encoder rerank). For best precision at the current data " +
        "scale, set OPENROUTER_API_KEY in .env.",
    );
    return null;
  }
  const modelName = model || envOptional("RERANK_MODEL") || DEFAULT_RERANK_MODEL;
  const baseUrl = envOptional("RERANK_BASE_URL") ?? DEFAULT_RERANK_BASE_URL;
  cached.reranker = new OpenRouterReranker({ apiKey, modelName, baseUrl });
  logger.info(`Reranker enabled: model=${pyRepr(modelName)} via ${baseUrl}`);
  return cached.reranker;
}

/** Forgets the cached reranker, so the next makeReranker() reads the env again. */
export function resetRerankerCache(): void {
  cached = null;
}
