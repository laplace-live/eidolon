// The install's embedding model, as queries and both ingests use it. Query-time vectors must come
// from the same model and dimension as the offline ingest's, or they aren't comparable.
import { embedDim } from "@eidolon/config";
import {
  type EmbeddingModel,
  EmbeddingUsage,
  embeddingModel,
  reportEmbedding,
  type Selection,
  selectRequired,
} from "@eidolon/providers";

let kept: { readonly selection: Selection; readonly model: EmbeddingModel } | null = null;

/** The embedding provider and model the install uses now: `embeddings.provider`, else OpenRouter. */
export function embeddingSelection(): Selection {
  return selectRequired("embeddings");
}

/**
 * The process's model for `model`, the settings' own when omitted. Its account is read from the
 * settings on first use and kept; without a key it throws, and keeps nothing, so the check repeats
 * per call.
 */
export function defaultEmbeddingModel(model?: string): EmbeddingModel {
  if (kept === null) {
    const selection = embeddingSelection();
    const opened = embeddingModel(model === undefined ? selection : { ...selection, model });
    kept = { selection, model: opened };
    return opened;
  }
  const wanted = model ?? embeddingSelection().model;
  if (kept.model.model !== wanted) {
    const { selection } = kept;
    kept = { selection, model: embeddingModel({ ...selection, model: wanted }) };
  }
  return kept.model;
}

/** Forgets the default model, so the next call reads the settings again. */
export function resetEmbeddingModel(): void {
  kept = null;
}

export interface EmbedOptions {
  model?: string | null;
  dimensions?: number | null;
  signal?: AbortSignal;
}

/**
 * Empty input makes no request. `model` defaults to the embeddings role's (EMBED_MODEL),
 * `dimensions` to EMBED_DIM.
 */
export async function embedTextsWithUsage(
  texts: readonly string[],
  options: EmbedOptions = {},
): Promise<[number[][], EmbeddingUsage]> {
  if (texts.length === 0) return [[], new EmbeddingUsage()];
  const model = defaultEmbeddingModel(options.model || undefined);
  const result = await model.embed(texts, options.dimensions || embedDim(), options.signal);
  reportEmbedding(model, result[1]);
  return result;
}

export async function embedTexts(
  texts: readonly string[],
  options: EmbedOptions = {},
): Promise<number[][]> {
  return (await embedTextsWithUsage(texts, options))[0];
}
