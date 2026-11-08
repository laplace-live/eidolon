import {
  envRaw,
  extractCostUsd,
  httpxStatusMessage,
  isPlainObject,
  logger,
  openrouterHeaders,
  pyRepr,
  pyStrip,
} from "@eidolon/config";
import { billingProvider, hasKey, reportUsage, select, type Units } from "@eidolon/providers";

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
  /** Sends OpenRouter's attribution headers; on by default. */
  openrouter?: boolean;
  /** What each rerank used, and what it cost when the response says. */
  onUsage?: (units: Units, reportedUsd: number | null) => void;
  fetch?: typeof fetch;
}

interface Reply {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body: ArrayBuffer;
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

/** What a rerank response says it used: Cohere's billed units, OpenRouter's cost. */
function rerankUsage(payload: unknown): { units: Units; reportedUsd: number | null } {
  const body = isPlainObject(payload) ? payload : {};
  const meta = isPlainObject(body.meta) ? body.meta : {};
  const billed = isPlainObject(meta.billed_units) ? meta.billed_units : {};
  const searches = typeof billed.search_units === "number" ? billed.search_units : 1;
  const tokens = typeof billed.input_tokens === "number" ? billed.input_tokens : undefined;
  const usage = isPlainObject(body.usage) ? body.usage : null;
  const reported = usage === null ? null : extractCostUsd(usage);
  return {
    units: { searches, ...(tokens === undefined ? {} : { inputTokens: tokens }) },
    reportedUsd: reported,
  };
}

/**
 * Cohere's rerank models through OpenRouter's `/rerank` route. OpenRouter mirrors Cohere's rerank
 * request and response bodies, so Cohere's own API takes the same calls.
 */
export class OpenRouterReranker implements Reranker {
  readonly modelName: string;
  readonly column: string;
  readonly topN: number | null;
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #openrouter: boolean;
  readonly #onUsage: OpenRouterRerankerOptions["onUsage"];
  readonly #fetch: typeof fetch | null;

  constructor(options: OpenRouterRerankerOptions) {
    this.modelName = options.modelName ?? DEFAULT_RERANK_MODEL;
    this.column = options.column ?? "text";
    this.topN = options.topN ?? null;
    this.baseUrl = (options.baseUrl ?? DEFAULT_RERANK_BASE_URL).replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#openrouter = options.openrouter ?? true;
    this.#onUsage = options.onUsage;
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
        ...(this.#openrouter ? openrouterHeaders() : {}),
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
    if (response.status < 200 || response.status >= 300) {
      throw new Error(httpxStatusMessage(response, url, { anyLocation: true }));
    }
    const answer: unknown = JSON.parse(new TextDecoder().decode(response.body));
    const results = parseResults(answer, documents.length);
    if (this.#onUsage) {
      const { units, reportedUsd } = rerankUsage(answer);
      this.#onUsage(units, reportedUsd);
    }
    return results;
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
  let selection: ReturnType<typeof select>;
  try {
    selection = select("rerank");
  } catch (error) {
    logger.warning(`Reranker off, hybrid retrieval will use RRF fusion: ${pyStrip(String(error))}`);
    return null;
  }
  if (selection === null || !hasKey(selection)) {
    logger.info(
      `${selection?.keyName ?? "The reranker's key"} is not set — hybrid retrieval will use ` +
        "LanceDB's default RRF fusion (no cross-encoder rerank). For best precision at the " +
        "current data scale, set it in credentials.json or the environment.",
    );
    return null;
  }
  const modelName = model || selection.model;
  const baseUrl = selection.baseUrl as string;
  const provider = selection.provider.id;
  cached.reranker = new OpenRouterReranker({
    apiKey: selection.apiKey as string,
    modelName,
    baseUrl,
    openrouter: provider === "openrouter",
    onUsage: (units, reportedUsd) =>
      reportUsage({
        role: "rerank",
        provider: billingProvider(provider, baseUrl),
        model: modelName,
        units,
        costUsd: reportedUsd,
      }),
  });
  logger.info(`Reranker enabled: model=${pyRepr(modelName)} via ${baseUrl}`);
  return cached.reranker;
}

/** Forgets the cached reranker, so the next makeReranker() reads the env again. */
export function resetRerankerCache(): void {
  cached = null;
}
