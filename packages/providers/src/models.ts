// The models an account can use, as its provider's API lists them: nothing here is a list of its
// own. A provider without a listing, or one that refuses, leaves the caller to take any id typed.
import { isPlainObject, withoutTrailingSlashes } from "@eidolon/config";
import type { Account } from "./accounts.ts";
import { ANTHROPIC_VERSION, type Category, type ProviderId } from "./catalog.ts";
import { errorMessageOf } from "./http/errors.ts";

export interface ListedModel {
  readonly id: string;
  /** The provider's own name for it, where that says more than the id. */
  readonly name?: string;
}

export type ModelListing =
  | { readonly status: "ok"; readonly models: readonly ListedModel[] }
  /** The provider has no listing of this kind of model. */
  | { readonly status: "unlisted" }
  /** It lists them only for a key, and the account has none. */
  | { readonly status: "no-key" }
  /** It refused the account's key. */
  | { readonly status: "refused" }
  | { readonly status: "failed"; readonly message: string };

interface Request {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly parse: (body: unknown) => ListedModel[];
}

function bearer(key: string | undefined): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** `name` set to `value`, or nothing without one. */
function header(name: string, value: string | undefined): Record<string, string> {
  return value ? { [name]: value } : {};
}

function rows(body: unknown, field: string): Record<string, unknown>[] {
  const list = isPlainObject(body) ? body[field] : body;
  return Array.isArray(list) ? list.filter(isPlainObject) : [];
}

function named(
  list: Record<string, unknown>[],
  idField: string,
  nameField?: string,
): ListedModel[] {
  const models: ListedModel[] = [];
  for (const row of list) {
    const id = row[idField];
    if (typeof id !== "string" || id === "") continue;
    const name = nameField === undefined ? undefined : row[nameField];
    models.push(typeof name === "string" && name && name !== id ? { id, name } : { id });
  }
  return models;
}

/** OpenAI's shape, `{data: [{id}]}`, which most compatible APIs answer with. */
const openaiData = (body: unknown) => named(rows(body, "data"), "id", "name");

// OpenAI lists every kind of model under one route; the ids say which is which.
const OPENAI_KINDS: Partial<Record<Category, RegExp>> = {
  stt: /transcribe|whisper/,
  tts: /tts/,
  // gpt-realtime-whisper only hears: it is speech recognition, not a voice that answers.
  realtime: /realtime(?!.*(whisper|transcribe))/,
  embedding: /embedding/,
};
const OPENAI_NOT_CHAT =
  /embedding|tts|whisper|transcribe|realtime|audio|dall-e|image|moderation|search|davinci|babbage|sora/;

function openaiKinds(models: ListedModel[], category: Category): ListedModel[] {
  const kind = OPENAI_KINDS[category];
  return models.filter((model) =>
    kind === undefined ? !OPENAI_NOT_CHAT.test(model.id) : kind.test(model.id),
  );
}

function geminiKinds(models: ListedModel[], category: Category): ListedModel[] {
  // Gemini's OpenAI-compatible listing names models `models/<id>`; chat takes the bare id.
  const bare = models.map((model) => ({ ...model, id: model.id.replace(/^models\//, "") }));
  const embedding = (id: string) => /embedding/.test(id);
  return bare.filter((model) =>
    category === "embedding"
      ? embedding(model.id)
      : /gemini|gemma/.test(model.id) &&
        !embedding(model.id) &&
        !/tts|image|live|audio/.test(model.id),
  );
}

/** How a provider lists `category`'s models for an account at `base`; null where it lists none. */
type Listing = (category: Category, base: string, key: string | undefined) => Request | null;

/** An OpenAI-compatible API's `/models`, its kinds told apart by `kinds`. */
function compatible(
  kinds: (models: ListedModel[], category: Category) => ListedModel[] = (models) => models,
): Listing {
  return (category, base, key) => ({
    url: `${base}/models`,
    headers: bearer(key),
    parse: (body) => kinds(openaiData(body), category),
  });
}

// OpenRouter's public lists, one route a kind.
const OPENROUTER_PATHS: Partial<Record<Category, string>> = {
  llm: "/models",
  embedding: "/embeddings/models",
  rerank: "/models?output_modalities=rerank",
  decision: "/models?output_modalities=decisions",
  image: "/models?output_modalities=image",
};

/**
 * Each provider's model listing, by catalog id. Fish's models are a closed set, and Cartesia and
 * MiniMax list none, so they have none here.
 */
export const LISTINGS: { readonly [P in ProviderId]?: Listing } = {
  openrouter: (category, base, key) => {
    const path = OPENROUTER_PATHS[category];
    return path === undefined
      ? null
      : { url: base + path, headers: bearer(key), parse: openaiData };
  },
  openai: compatible(openaiKinds),
  anthropic: (_category, base, key) => ({
    url: `${base}/models?limit=1000`,
    headers: { ...header("x-api-key", key), "anthropic-version": ANTHROPIC_VERSION },
    parse: (body) => named(rows(body, "data"), "id", "display_name"),
  }),
  google: compatible(geminiKinds),
  deepseek: compatible(),
  xai: compatible(),
  qwen: compatible(),
  moonshot: compatible(),
  zhipu: compatible(),
  ollama: compatible(),
  "openai-compatible": compatible(),
  soniox: (category, base, key) => ({
    url: `${base}/models`,
    headers: bearer(key),
    parse: (body) => {
      const mode = category === "transcription" ? "async" : "real_time";
      return named(
        rows(body, "models").filter((row) =>
          category === "tts"
            ? typeof row.id === "string" && row.id.startsWith("tts")
            : row.transcription_mode === mode,
        ),
        "id",
        "name",
      );
    },
  }),
  elevenlabs: (category, base, key) =>
    category !== "tts"
      ? null
      : {
          url: `${base}/v1/models`,
          headers: header("xi-api-key", key),
          parse: (body) =>
            named(
              rows(body, "models").filter((row) => row.can_do_text_to_speech === true),
              "model_id",
              "name",
            ),
        },
  deepgram: (category, base, key) =>
    category !== "stt"
      ? null
      : {
          url: `${base}/v1/models`,
          headers: header("Authorization", key && `Token ${key}`),
          parse: (body) => [
            ...new Map(
              named(rows(body, "stt"), "canonical_name").map((model) => [model.id, model]),
            ).values(),
          ],
        },
  cohere: (category, base, key) =>
    category !== "rerank"
      ? null
      : {
          // Its listing is under v1 whatever version the account's base names.
          url: `${base.replace(/\/v\d+$/, "")}/v1/models?endpoint=rerank&page_size=1000`,
          headers: bearer(key),
          parse: (body) => named(rows(body, "models"), "name"),
        },
};

/** How `account`'s provider lists `category`'s models; null where it has no listing. */
function requestFor(account: Account, category: Category): Request | null {
  if (account.baseUrl === undefined) return null;
  const base = withoutTrailingSlashes(account.baseUrl);
  return LISTINGS[account.provider.id]?.(category, base, account.apiKey) ?? null;
}

/** Providers whose listing answers without a key. */
const PUBLIC = new Set(["openrouter", "ollama", "openai-compatible"]);

/** `account`'s models of `category`, as its provider lists them now. */
export async function listModels(
  account: Account,
  category: Category,
  options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<ModelListing> {
  const request = requestFor(account, category);
  if (request === null) return { status: "unlisted" };
  if (account.apiKey === undefined && !PUBLIC.has(account.provider.id)) return { status: "no-key" };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(request.url, {
      headers: { Accept: "application/json", ...request.headers },
      signal: options.signal ?? AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const host = new URL(request.url).host;
    const late = error instanceof Error && error.name === "TimeoutError";
    return { status: "failed", message: late ? `${host} didn't answer` : `couldn't reach ${host}` };
  }
  const text = await response.text().catch(() => "");
  if (response.status === 404 || response.status === 405) return { status: "unlisted" };
  if (response.status === 401 || response.status === 403) return { status: "refused" };
  if (!response.ok) {
    const message = `${response.status}: ${errorMessageOf(text)}`;
    return {
      status: "failed",
      message: message.length > 160 ? `${message.slice(0, 159)}…` : message,
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { status: "failed", message: "the listing isn't JSON" };
  }
  const models = request.parse(body).sort((a, b) => a.id.localeCompare(b.id));
  return { status: "ok", models };
}
