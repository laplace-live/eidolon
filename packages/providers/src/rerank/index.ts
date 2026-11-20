// Rerankers: one request orders documents by how well each answers a query. Hybrid search reranks
// its candidates through this interface alone.
import type { ProviderId } from "../catalog.ts";
import { hasKey, missingKey, ProviderConfigError, type Selection } from "../resolve.ts";
import { cohereRerank } from "./cohere.ts";
import { openRouterRerank } from "./openrouter.ts";

export interface RerankResult {
  /** Index into the documents sent. */
  readonly index: number;
  readonly relevanceScore: number | null;
}

export interface RerankModel {
  /** Whose API it reaches, as the usage ledger names it. */
  readonly provider: string;
  readonly model: string;
  /**
   * Results best first, as the provider ranked them, the request's usage reported as the rerank
   * role's; rejects on any failure, `signal`'s abort included.
   */
  rerank(
    query: string,
    documents: readonly unknown[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<RerankResult[]>;
}

export interface RerankModelOptions {
  readonly fetch?: typeof fetch;
}

type KeyedSelection = Selection & { readonly apiKey: string };

/** Each provider's rerankers, by catalog id: one for every provider whose offer has them. */
export const RERANK_MODELS: {
  readonly [P in ProviderId]?: (
    selection: KeyedSelection,
    options: RerankModelOptions,
  ) => RerankModel;
} = {
  openrouter: (selection, options) =>
    openRouterRerank({
      ...options,
      apiKey: selection.apiKey,
      model: selection.model,
      baseUrl: selection.baseUrl as string,
    }),
  cohere: (selection, options) =>
    cohereRerank({
      ...options,
      apiKey: selection.apiKey,
      model: selection.model,
      baseUrl: selection.baseUrl as string,
    }),
};

/** `selection`'s reranker; throws before any request when it has no key. */
export function rerankModel(selection: Selection, options: RerankModelOptions = {}): RerankModel {
  const open = RERANK_MODELS[selection.provider.id];
  if (open === undefined) {
    throw new ProviderConfigError(`${selection.provider.name} has no rerankers in Eidolon`);
  }
  if (!hasKey(selection)) throw missingKey(selection);
  return open(selection as KeyedSelection, options);
}
