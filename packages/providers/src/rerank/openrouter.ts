// OpenRouter's `/rerank` route: Cohere's request with OpenRouter's attribution headers, sent wherever
// the account's base points, Cohere's own API included when RERANK_BASE_URL names it.
import { openrouterHeaders } from "@eidolon/config";
import { type CohereRerankOptions, cohereRerank } from "./cohere.ts";
import type { RerankModel } from "./index.ts";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterRerankOptions
  extends Omit<CohereRerankOptions, "baseUrl" | "provider" | "headers"> {
  /** OpenRouter's v1 API by default; a trailing "/" is stripped. */
  readonly baseUrl?: string;
}

/** One model on OpenRouter's rerank route, billed to whoever's API `baseUrl` is on. */
export function openRouterRerank(options: OpenRouterRerankOptions): RerankModel {
  return cohereRerank({
    ...options,
    baseUrl: options.baseUrl ?? OPENROUTER_BASE_URL,
    provider: "openrouter",
    headers: openrouterHeaders,
  });
}
