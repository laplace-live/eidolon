// Embedding models: texts in, a vector each. Retrieval's queries and ingests and Mem0's memories
// embed through this interface alone.
import { openrouterHeaders } from "@eidolon/config";
import type { ProviderId } from "../catalog.ts";
import { openModel, type Selection } from "../resolve.ts";
import { billingProvider, reportUsage } from "../usage.ts";
import { type EmbeddingClientOptions, type EmbeddingUsage, openAIEmbeddings } from "./openai.ts";

export interface EmbeddingModel {
  /** Its provider's catalog id, as the usage ledger names it. */
  readonly provider: string;
  readonly model: string;
  /**
   * One request's vectors, in the order of `texts`, and what it used; no texts, no request.
   * Rejects on any failure, `signal`'s abort included.
   */
  embed(
    texts: readonly string[],
    dimensions: number,
    signal?: AbortSignal,
  ): Promise<[number[][], EmbeddingUsage]>;
}

/** How often a failed request goes again, by why it failed. */
export interface EmbeddingRetries {
  /** A dropped connection, a timeout, a 408, 409, 429 or 5xx, as the OpenAI SDK retries them. */
  readonly http: number;
  /** A 200 without vectors, which is how OpenRouter passes an upstream error on. */
  readonly empty: number;
  /** Such a 200 whose error is a quota's, each a minute after the last. */
  readonly quota: number;
}

export interface EmbeddingModelOptions {
  /** Each budget left out is an offline ingest's, quota windows included. */
  readonly retries?: Partial<EmbeddingRetries>;
  readonly fetch?: typeof fetch;
}

/** OpenAI's embeddings request at `selection`'s API base, with its key. */
function compatible(
  selection: Selection,
  options: EmbeddingModelOptions,
  wire: Pick<EmbeddingClientOptions, "headers" | "openrouter"> = { openrouter: false },
): EmbeddingModel {
  return openAIEmbeddings({
    ...options,
    ...wire,
    provider: billingProvider(selection.provider.id, selection.baseUrl),
    model: selection.model,
    baseUrl: selection.baseUrl as string,
    apiKey: selection.apiKey ?? "",
  });
}

/** Each provider's embedding models, by catalog id: one for every provider whose offer has them. */
export const EMBEDDING_MODELS: {
  readonly [P in ProviderId]?: (
    selection: Selection,
    options: EmbeddingModelOptions,
  ) => EmbeddingModel;
} = {
  // Its `usage` field asks for each request's cost; its headers attribute the traffic.
  openrouter: (selection, options) =>
    compatible(selection, options, { headers: openrouterHeaders(), openrouter: true }),
  openai: compatible,
  google: compatible,
  "openai-compatible": compatible,
};

/** `selection`'s embedding model; throws before any request when it has no key. */
export function embeddingModel(
  selection: Selection,
  options: EmbeddingModelOptions = {},
): EmbeddingModel {
  return openModel(EMBEDDING_MODELS, "embedding models", selection, options);
}

/** Records what one of `model`'s requests used, as the embeddings role's spend. */
export function reportEmbedding(model: EmbeddingModel, usage: EmbeddingUsage): void {
  reportUsage({
    role: "embeddings",
    provider: model.provider,
    model: model.model,
    units: { inputTokens: usage.totalTokens },
    costUsd: usage.costSource === "openrouter" ? usage.costUsd : null,
    estimatedUsd: usage.costSource === "estimate" ? usage.costUsd : null,
  });
}
