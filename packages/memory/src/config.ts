// Self-hosted Mem0 configuration: the OSS engine runs in-process with Qdrant holding the vectors.
// Fact extraction reuses the persona LLM through OpenRouter, and embeddings reuse retrieval's model
// and dimension so one EMBED_MODEL / EMBED_DIM pair governs every vector this project writes.
// Qdrant pins the collection's dimension at creation, so changing EMBED_DIM means dropping
// MEM0_QDRANT_COLLECTION and letting viewers re-accumulate: old vectors are not comparable.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_EMBED_BASE_URL,
  DEFAULT_EMBED_MODEL,
  embedDim,
  envFloat,
  envInt,
  envOptional,
  envRaw,
  pyFloatRepr,
  pyStrip,
} from "@eidolon/config";
import type { QdrantSettings } from "./qdrant.ts";

export const DEFAULT_QDRANT_PORT = 6333;
export const DEFAULT_COLLECTION = "eidolon_memories";
export const DEFAULT_HISTORY_DB_PATH = "data/mem0/history.db";
export const DEFAULT_LLM_MODEL = "~google/gemini-flash-latest";
export const DEFAULT_SEARCH_LIMIT = 10;
export const DEFAULT_SEARCH_THRESHOLD = 0.3;

export const EMBED_KEY_MISSING =
  "Self-hosted Mem0 needs an embedding API key. Set OPENROUTER_API_KEY (reused from the LLM config) or EMBED_API_KEY for a different provider.";
const LLM_KEY_MISSING =
  "The api_key client option must be set either by passing api_key to the client or by setting the OPENAI_API_KEY environment variable";

export interface EmbedderSettings {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly dims: number;
}

export interface LlmSettings {
  readonly model: string;
  /** null when neither OPENROUTER_API_KEY nor OPENAI_API_KEY is set; opening the engine fails. */
  readonly apiKey: string | null;
  readonly baseUrl: string;
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

/** The LLM client mem0 picks on its own: OpenRouter whenever OPENROUTER_API_KEY is set. */
function llmSettings(): LlmSettings {
  const model =
    envOptional("MEM0_LLM_MODEL") ?? envOptional("OPENROUTER_MODEL") ?? DEFAULT_LLM_MODEL;
  const openrouterKey = envOptional("OPENROUTER_API_KEY");
  if (openrouterKey) {
    const baseUrl = envOptional("OPENROUTER_API_BASE") ?? "https://openrouter.ai/api/v1";
    return { model, apiKey: openrouterKey, baseUrl };
  }
  const baseUrl = envOptional("OPENAI_BASE_URL") ?? "https://api.openai.com/v1";
  return { model, apiKey: envOptional("OPENAI_API_KEY") ?? null, baseUrl };
}

/**
 * Reads the whole configuration and creates the history DB's parent directory. Throws when memory
 * is off or no embedding key is set, which would otherwise surface as an opaque 401 on the first
 * memory write.
 */
export function buildMemoryConfig(): MemoryConfig {
  const host = qdrantHost();
  if (!host) throw new Error("MEM0_QDRANT_HOST is unset, so there is no vector store");
  const embedApiKey = envOptional("EMBED_API_KEY") ?? envOptional("OPENROUTER_API_KEY");
  if (!embedApiKey) throw new Error(EMBED_KEY_MISSING);
  // bun:sqlite, like sqlite3, raises rather than create missing parents, and the history DB
  // lands under a mounted volume that starts empty.
  const historyDbPath = envOptional("MEM0_HISTORY_DB_PATH") ?? DEFAULT_HISTORY_DB_PATH;
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
      model: envOptional("EMBED_MODEL") ?? DEFAULT_EMBED_MODEL,
      apiKey: embedApiKey,
      baseUrl: envOptional("EMBED_BASE_URL") ?? DEFAULT_EMBED_BASE_URL,
      dims,
    },
    llm: llmSettings(),
    historyDbPath,
  };
}

/** Throws where opening mem0's OpenAI client would: no key at all. */
export function requireLlmKey(llm: LlmSettings): string {
  if (llm.apiKey === null) throw new Error(LLM_KEY_MISSING);
  return llm.apiKey;
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
