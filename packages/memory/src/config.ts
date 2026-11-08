// Self-hosted Mem0 configuration: the OSS engine runs in-process with Qdrant holding the vectors.
// Fact extraction is the memory role's model (the persona's chat model unless she names another),
// and embeddings reuse retrieval's model and dimension so one EMBED_MODEL / EMBED_DIM pair governs
// every vector this project writes. Qdrant pins the collection's dimension at creation, so
// changing EMBED_DIM means dropping MEM0_QDRANT_COLLECTION and letting viewers re-accumulate: old
// vectors are not comparable.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dataHome,
  embedDim,
  envFloat,
  envInt,
  envOptional,
  envRaw,
  pyFloatRepr,
  pyStrip,
} from "@eidolon/config";
import { hasKey, missingKey, selectRequired } from "@eidolon/providers";
import type { QdrantSettings } from "./qdrant.ts";

export const DEFAULT_QDRANT_PORT = 6333;
export const DEFAULT_COLLECTION = "eidolon_memories";
/** Mem0's change log, under the data home: memories are per install, not per persona. */
export const historyDbDefault = (): string => join(dataHome(), "mem0", "history.db");
export const DEFAULT_SEARCH_LIMIT = 10;
export const DEFAULT_SEARCH_THRESHOLD = 0.3;

export interface EmbedderSettings {
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly dims: number;
}

export interface LlmSettings {
  readonly provider: string;
  readonly model: string;
  /** null when the memory role's key is unset; opening the engine fails. */
  readonly apiKey: string | null;
  readonly baseUrl: string;
  /** Why opening it fails, when it would. */
  readonly keyMissing: string | null;
}

export interface MemoryConfig {
  readonly qdrant: QdrantSettings;
  readonly embedder: EmbedderSettings;
  readonly llm: LlmSettings;
  readonly historyDbPath: string;
}

export interface MemorySearchSettings {
  readonly searchLimit: number;
  readonly searchThreshold: number;
}

/** `MEM0_QDRANT_HOST`, trimmed; empty when memory is off. */
export function qdrantHost(): string {
  return pyStrip(envRaw("MEM0_QDRANT_HOST") ?? "");
}

/** The memory role: `memory.provider` and `memory.model`, else the persona's chat model. */
function llmSettings(): LlmSettings {
  const selection = selectRequired("memory");
  return {
    provider: selection.provider.id,
    model: selection.model,
    apiKey: selection.apiKey ?? null,
    baseUrl: selection.baseUrl as string,
    keyMissing: hasKey(selection) ? null : missingKey(selection).message,
  };
}

/**
 * Reads the whole configuration and creates the history DB's parent directory. Throws when memory
 * is off or no embedding key is set, which would otherwise surface as an opaque 401 on the first
 * memory write.
 */
export function buildMemoryConfig(): MemoryConfig {
  const host = qdrantHost();
  if (!host) throw new Error("MEM0_QDRANT_HOST is unset, so there is no vector store");
  const embeddings = selectRequired("embeddings");
  if (!hasKey(embeddings)) throw missingKey(embeddings);
  // bun:sqlite, like sqlite3, raises rather than create missing parents, and the history DB
  // lands under a mounted volume that starts empty.
  const historyDbPath = envOptional("MEM0_HISTORY_DB_PATH") ?? historyDbDefault();
  mkdirSync(dirname(historyDbPath), { recursive: true });
  const port = envInt("MEM0_QDRANT_PORT", DEFAULT_QDRANT_PORT);
  // mem0 swaps a zero port for an embedded on-disk store; the JS client has none and would
  // dial port 80 instead.
  if (port <= 0) throw new Error(`MEM0_QDRANT_PORT=${port} is not a Qdrant server port`);
  const dims = embedDim();
  return {
    qdrant: {
      host,
      port,
      collection: envOptional("MEM0_QDRANT_COLLECTION") ?? DEFAULT_COLLECTION,
      vectorSize: dims,
    },
    embedder: {
      provider: embeddings.provider.id,
      model: embeddings.model,
      apiKey: embeddings.apiKey ?? "",
      baseUrl: embeddings.baseUrl as string,
      dims,
    },
    llm: llmSettings(),
    historyDbPath,
  };
}

/** Throws where opening the extraction client would: the memory role's provider needs a key it lacks. */
export function requireLlmKey(llm: LlmSettings): string {
  if (llm.keyMissing !== null) throw new Error(llm.keyMissing);
  return llm.apiKey ?? "";
}

function constraintError(
  field: string,
  kind: "ge" | "le",
  bound: number,
  input: string,
  type: string,
): string {
  const [code, words] =
    kind === "ge"
      ? ["greater_than_equal", "greater than or equal to"]
      : ["less_than_equal", "less than or equal to"];
  return (
    `${field}\n  Input should be ${words} ${bound} [type=${code}, input_value=${input}, input_type=${type}]\n` +
    `    For further information visit https://errors.pydantic.dev/2.13/v/${code}`
  );
}

/**
 * MEM0_SEARCH_LIMIT and MEM0_SEARCH_THRESHOLD, validated as Pipecat's pydantic `InputParams` does
 * (limit >= 1, threshold in [0, 1], NaN rejected), with its error text.
 */
export function memorySearchSettingsFromEnv(): MemorySearchSettings {
  const searchLimit = envInt("MEM0_SEARCH_LIMIT", DEFAULT_SEARCH_LIMIT);
  const searchThreshold = envFloat("MEM0_SEARCH_THRESHOLD", DEFAULT_SEARCH_THRESHOLD);
  const errors: string[] = [];
  if (!(searchLimit >= 1)) {
    errors.push(constraintError("search_limit", "ge", 1, String(searchLimit), "int"));
  }
  const threshold = pyFloatRepr(searchThreshold);
  // pydantic checks `le` before `ge`, which is why NaN reports the upper bound.
  if (!(searchThreshold <= 1)) {
    errors.push(constraintError("search_threshold", "le", 1, threshold, "float"));
  } else if (!(searchThreshold >= 0)) {
    errors.push(constraintError("search_threshold", "ge", 0, threshold, "float"));
  }
  if (errors.length) {
    const count = errors.length === 1 ? "1 validation error" : `${errors.length} validation errors`;
    throw new RangeError(`${count} for InputParams\n${errors.join("\n")}`);
  }
  return { searchLimit, searchThreshold };
}
