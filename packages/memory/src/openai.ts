// mem0's OpenAI embedder and extraction LLM over an OpenAI-compatible endpoint.
import { isPlainObject, pyError, pyTypeName } from "@eidolon/config";
import type { JsonPoster } from "./openai-http.ts";

const EMBED_BATCH_SIZE = 100;

export interface Embedder {
  embed(text: unknown): Promise<number[]>;
  embedBatch(texts: readonly unknown[]): Promise<number[][]>;
}

function field(value: unknown, key: string, owner: string): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, key)) {
    throw pyError("AttributeError", `'${owner}' object has no attribute '${key}'`);
  }
  return value[key];
}

function first(list: unknown): unknown {
  if (list === null) throw pyError("TypeError", "'NoneType' object is not subscriptable");
  if (!Array.isArray(list) || list.length === 0) {
    throw pyError("IndexError", "list index out of range");
  }
  return list[0];
}

/** `text.replace("\n", " ")`, which raises for anything but a string. */
function flatten(text: unknown): string {
  if (typeof text !== "string") {
    throw pyError("AttributeError", `'${pyTypeName(text)}' object has no attribute 'replace'`);
  }
  return text.replaceAll("\n", " ");
}

export class OpenAICompatibleEmbedder implements Embedder {
  readonly #model: string;
  readonly #dims: number;
  readonly #client: JsonPoster;

  constructor(settings: { readonly model: string; readonly dims: number }, client: JsonPoster) {
    this.#model = settings.model;
    this.#dims = settings.dims;
    this.#client = client;
  }

  #body(input: string[]): Record<string, unknown> {
    // `dimensions` goes out because the dimension is configured; mem0 sends it only then.
    return { input, model: this.#model, encoding_format: "float", dimensions: this.#dims };
  }

  async embed(text: unknown): Promise<number[]> {
    const response = await this.#client.post("embeddings", this.#body([flatten(text)]));
    const data = field(response, "data", "CreateEmbeddingResponse");
    return field(first(data), "embedding", "Embedding") as number[];
  }

  async embedBatch(texts: readonly unknown[]): Promise<number[][]> {
    const inputs = texts.map(flatten);
    const embeddings: number[][] = [];
    for (let i = 0; i < inputs.length; i += EMBED_BATCH_SIZE) {
      const response = await this.#client.post(
        "embeddings",
        this.#body(inputs.slice(i, i + EMBED_BATCH_SIZE)),
      );
      const data = field(response, "data", "CreateEmbeddingResponse");
      if (!Array.isArray(data))
        throw pyError("TypeError", `'${pyTypeName(data)}' object is not iterable`);
      const ordered = [...data].sort(
        (a, b) => Number(field(a, "index", "Embedding")) - Number(field(b, "index", "Embedding")),
      );
      for (const item of ordered)
        embeddings.push(field(item, "embedding", "Embedding") as number[]);
    }
    if (embeddings.length !== inputs.length) {
      throw pyError(
        "ValueError",
        `OpenAI embed_batch() returned ${embeddings.length} embeddings for ${inputs.length} texts` +
          ` using model '${this.#model}'`,
      );
    }
    return embeddings;
  }
}

export interface ChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface ExtractionLlm {
  /** One JSON-mode chat completion; resolves to the first choice's `message.content`, as sent. */
  complete(messages: readonly ChatMessage[]): Promise<unknown>;
}

const REASONING_MODELS = new Set([
  "o1",
  "o1-preview",
  "o3-mini",
  "o3",
  "gpt-5",
  "gpt-5o",
  "gpt-5o-mini",
  "gpt-5o-micro",
]);

function baseModel(model: string): string {
  const lower = model.toLowerCase();
  return lower.slice(lower.lastIndexOf("/") + 1);
}

/** mem0's name heuristic for models that reject temperature, top_p and a token cap. */
export function isReasoningModel(model: string): boolean {
  const base = baseModel(model);
  return REASONING_MODELS.has(base) || ["o1-", "o1.", "o3-", "o3."].some((p) => base.startsWith(p));
}

/**
 * mem0 caps the reply at 2000 tokens, but a thinking model's reasoning counts toward the cap. The
 * default Gemini Flash thinks a median ~1,300 tokens per extraction and up to ~2,600, so under
 * mem0's cap about 1 in 12 replies (measured 2026-11-04) ended mid-JSON and their memories were lost.
 */
export const EXTRACTION_MAX_TOKENS = 8192;

/** The request body mem0's OpenAI LLM builds, keys in its order; only the token cap differs. */
export function extractionRequestBody(
  model: string,
  messages: readonly ChatMessage[],
): Record<string, unknown> {
  const sampling: Record<string, unknown> = isReasoningModel(model)
    ? {}
    : {
        temperature: 0.1,
        top_p: 0.1,
        [baseModel(model).startsWith("gpt-5") ? "max_completion_tokens" : "max_tokens"]:
          EXTRACTION_MAX_TOKENS,
      };
  return { ...sampling, messages, model, response_format: { type: "json_object" } };
}

export class OpenAICompatibleChat implements ExtractionLlm {
  readonly #model: string;
  readonly #client: JsonPoster;

  constructor(model: string, client: JsonPoster) {
    this.#model = model;
    this.#client = client;
  }

  async complete(messages: readonly ChatMessage[]): Promise<unknown> {
    const response = await this.#client.post(
      "chat/completions",
      extractionRequestBody(this.#model, messages),
    );
    const choice = first(field(response, "choices", "ChatCompletion"));
    const message = field(choice, "message", "Choice");
    if (!isPlainObject(message)) {
      throw pyError("AttributeError", `'${pyTypeName(message)}' object has no attribute 'content'`);
    }
    return message.content ?? null;
  }
}
