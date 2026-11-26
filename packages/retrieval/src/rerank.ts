import { envRaw, logger, pyRepr, pyStrip } from "@eidolon/config";
import { hasKey, type RerankModel, rerankModel, select } from "@eidolon/providers";

const RERANK_OFF = new Set(["false", "0", "no", "off"]);
// By the settings each was built from: knowledge.rerank is each persona's own.
const rerankers = new Map<string, RerankModel>();
/** Why reranking is off, each logged once. */
const offReasons = new Set<string>();

function rerankOff(level: "info" | "warning", reason: string): null {
  if (!offReasons.has(reason)) {
    offReasons.add(reason);
    logger[level](reason);
  }
  return null;
}

/**
 * The cross-encoder reranker the settings select now, or null when switched off; the same settings
 * get the same instance. With null, hybrid search fuses the legs with RRF, which beat
 * LinearCombinationReranker throughout our eval: its score normalisation ties the top results and
 * randomises their order. `cohere/rerank-4-fast` reads query and candidate together, so it catches
 * intent no score combiner can, at $0.002 per search unit on the same OpenRouter account.
 */
export function makeReranker(model?: string | null): RerankModel | null {
  if (RERANK_OFF.has(pyStrip(envRaw("RERANK_ENABLED") ?? "").toLowerCase())) {
    return rerankOff("info", "RERANK_ENABLED is off — hybrid retrieval will use RRF fusion");
  }
  let selection: ReturnType<typeof select>;
  try {
    selection = select("rerank");
  } catch (error) {
    return rerankOff(
      "warning",
      `Reranker off, hybrid retrieval will use RRF fusion: ${pyStrip(String(error))}`,
    );
  }
  if (selection === null || !hasKey(selection)) {
    return rerankOff(
      "info",
      `${selection?.keyName ?? "The reranker's key"} is not set — hybrid retrieval will use ` +
        "RRF fusion (no cross-encoder rerank). For best precision at the " +
        "current data scale, set it in credentials.json or the environment.",
    );
  }
  const modelName = model || selection.model;
  const baseUrl = selection.baseUrl as string;
  const key = JSON.stringify([
    selection.account.id,
    selection.provider.id,
    modelName,
    baseUrl,
    selection.apiKey,
  ]);
  let reranker = rerankers.get(key);
  if (reranker === undefined) {
    reranker = rerankModel({ ...selection, model: modelName });
    rerankers.set(key, reranker);
    logger.info(`Reranker enabled: model=${pyRepr(modelName)} via ${baseUrl}`);
  }
  return reranker;
}

/** Forgets every reranker and reason, so each settings state builds and logs its own again. */
export function resetRerankerCache(): void {
  rerankers.clear();
  offReasons.clear();
}
