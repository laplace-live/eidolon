// Cohere's rerank API: one POST ranks every document against the query. OpenRouter's `/rerank` route
// mirrors its request and response bodies, so OpenRouter's reranker is this one on its account.
import {
  extractCostUsd,
  httpxStatusMessage,
  isPlainObject,
  logger,
  pyRepr,
  withoutTrailingSlashes,
} from "@eidolon/config";
import type { Units } from "../pricing.ts";
import { billingProvider, reportUsage } from "../usage.ts";
import type { RerankModel, RerankModelOptions, RerankResult } from "./index.ts";

export const RERANK_TIMEOUT_SEC = 10;

// OpenRouter's rerank route 429s on roughly half its calls whatever the
// pacing: 3/8 from a cold minute on 2026-09-07, where the same Cohere key
// called directly went 8/8. Outcomes are independent rather than a rate
// window — successes and failures interleave one call apart — so an
// immediate retry is worth more than a backoff, and three attempts take
// ~50% up to ~90%. Rejections come back in ~400ms (vs ~450ms for a success),
// which is what bounds the worst case here.
const RERANK_MAX_ATTEMPTS = 3;

export interface CohereRerankOptions extends RerankModelOptions {
  readonly apiKey: string;
  readonly model: string;
  /** The API base `/rerank` goes under; a trailing "/" is stripped. */
  readonly baseUrl: string;
  /** Unset leaves `top_n` out of the request. */
  readonly topN?: number;
  /** The account's provider, Cohere by default; the ledger bills whoever's API `baseUrl` is on. */
  readonly provider?: string;
  /** Headers of that account's own, made for each request. */
  readonly headers?: () => Record<string, string>;
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

/** One model on Cohere's rerank API, or on an account whose API takes Cohere's bodies. */
export function cohereRerank(options: CohereRerankOptions): RerankModel {
  const baseUrl = withoutTrailingSlashes(options.baseUrl);
  const url = `${baseUrl}/rerank`;
  const provider = billingProvider(options.provider ?? "cohere", baseUrl);
  const { model } = options;
  return {
    provider,
    model,
    async rerank(query, documents, signal) {
      if (documents.length === 0) return [];
      const payload: Record<string, unknown> = { model, query, documents };
      if (options.topN !== undefined) payload.top_n = options.topN;
      const init = {
        method: "POST",
        headers: {
          ...options.headers?.(),
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        // httpx doesn't follow redirects, so a 3xx is a failure there too.
        redirect: "manual",
      } satisfies RequestInit;
      const post = async (): Promise<Reply> => {
        const timeout = AbortSignal.timeout(RERANK_TIMEOUT_SEC * 1000);
        const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
          const response = await (options.fetch ?? fetch)(url, { ...init, signal: both });
          // Read inside the timeout, as httpx's read timeout covers the body.
          const body = await response.arrayBuffer();
          const { status, statusText, headers } = response;
          return { status, statusText, headers, body };
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
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
      const { units, reportedUsd } = rerankUsage(answer);
      reportUsage({ role: "rerank", provider, model, units, costUsd: reportedUsd });
      return results;
    },
  };
}
