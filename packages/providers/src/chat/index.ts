// Each provider's chat API: the wire it speaks, Anthropic's Messages API or OpenAI-compatible chat
// completions, and where it parts from OpenAI's own. The minds in @eidolon/engine and the JSON
// posters read it.
// Ports parts of pipedog's OpenAI, OpenRouter and DeepSeek LLM services
// (BSD-2-Clause; Copyright (c) 2024–2026 Daily, Copyright (c) 2026 pipedog contributors).
import { openrouterHeaders } from "@eidolon/config";
import type { ProviderId } from "../catalog.ts";

type Body = Readonly<Record<string, unknown>>;

interface Dialect {
  /** Fields over every other in a mind's request to `model`, the catalog's call-time ones too. */
  readonly fields?: (model: string) => Body;
}

/** Anthropic's Messages API. */
export interface MessagesDialect extends Dialect {
  readonly wire: "anthropic";
  /** A task's reply cap, thinking included; her chat's is the mind's own. */
  readonly taskMaxTokens: number;
}

/** An OpenAI-compatible chat completions API. */
export interface CompletionsDialect extends Dialect {
  readonly wire: "openai";
  /** Headers on a mind's every request and `chatPoster`'s, under the caller's. */
  readonly headers?: () => Record<string, string>;
  /** Fields under a mind's own in each of its requests. */
  readonly extraBody?: Body;
  /** The usage block carries what the request cost. */
  readonly reportsCost?: boolean;
  /** Takes `OPENROUTER_FIELDS`, which a JSON caller's body may carry. */
  readonly openRouterFields?: boolean;
  /** Takes a `developer` message, which goes as a user message everywhere else. */
  readonly developer?: boolean;
  /** Whether `model` takes one system message, so that later ones go as user messages. */
  readonly oneSystem?: (model: string) => boolean;
  /** Wants a `reasoning_content` on every assistant message. */
  readonly reasoningContent?: boolean;
  /**
   * Refuses a request with `stop`, as OpenAI's and xAI's reasoning models do
   * (https://platform.openai.com/docs/api-reference/chat/create#chat-create-stop,
   * https://docs.x.ai/docs/guides/reasoning).
   */
  readonly rejectsStop?: boolean;
  /** A JSON caller's chat completions body as the API takes it. */
  readonly chatBody?: (body: Body) => Record<string, unknown>;
}

export type ChatDialect = MessagesDialect | CompletionsDialect;

// OpenRouter's own request fields, which OpenAI and others refuse as unknown arguments.
export const OPENROUTER_FIELDS = ["usage", "provider"] as const;

// OpenAI's reasoning models: the o series and GPT-5 on. They refuse a temperature or top_p.
const OPENAI_REASONING = /^(?:o\d|gpt-(?:[5-9]|\d{2,}))/;

/**
 * A body as OpenAI's own API takes it: `max_tokens` is `max_completion_tokens` there, which every
 * model accepts and its newer ones require; OpenRouter translates this itself.
 */
export function forOpenAI(body: Body): Record<string, unknown> {
  const { max_tokens: cap, ...rest } = body;
  const model = typeof body.model === "string" ? body.model.toLowerCase() : "";
  const out: Record<string, unknown> = { ...rest };
  if (OPENAI_REASONING.test(model)) {
    delete out.temperature;
    delete out.top_p;
  }
  if (cap !== undefined && out.max_completion_tokens === undefined) {
    out.max_completion_tokens = cap;
  }
  return out;
}

/** Models whose refusals Anthropic retries on another model when a request asks for fallbacks. */
const ANTHROPIC_FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
  "claude-opus-5",
]);

const COMPATIBLE: CompletionsDialect = { wire: "openai" };

/** Each provider's chat API, by catalog id: one for every provider that offers chat models. */
export const CHAT_DIALECTS: { readonly [P in ProviderId]?: ChatDialect } = {
  openrouter: {
    wire: "openai",
    headers: openrouterHeaders,
    extraBody: { usage: { include: true } },
    reportsCost: true,
    openRouterFields: true,
    // pipedog's OpenRouter service sends Gemini's routes one system message, matched by name.
    oneSystem: (model) => model.toLowerCase().includes("gemini"),
  },
  openai: { wire: "openai", developer: true, rejectsStop: true, chatBody: forOpenAI },
  anthropic: {
    wire: "anthropic",
    // The most every model Anthropic serves accepts (Haiku 4.5, Sonnet 4.5 and Opus 4.5 stop at
    // 64K, the rest at 128K), so one long `write` fits
    // (https://platform.claude.com/docs/en/build-with-claude/thinking#output-limits).
    taskMaxTokens: 64_000,
    fields: (model) => (ANTHROPIC_FALLBACK_MODELS.has(model) ? { fallbacks: "default" } : {}),
  },
  google: { wire: "openai", oneSystem: () => true },
  deepseek: {
    wire: "openai",
    reasoningContent: true,
    // pipedog sends DeepSeek's `thinking` in `extra_body`, which lands over every other field.
    fields: () => ({ thinking: { type: "disabled" } }),
  },
  xai: { wire: "openai", rejectsStop: true },
  qwen: COMPATIBLE,
  moonshot: COMPATIBLE,
  zhipu: COMPATIBLE,
  ollama: COMPATIBLE,
  "openai-compatible": COMPATIBLE,
};

/**
 * `provider`'s chat API; one with no entry, such as an embedding provider a JSON caller posts to,
 * is a plain OpenAI-compatible one.
 */
export function chatDialect(provider: string): ChatDialect {
  return CHAT_DIALECTS[provider as ProviderId] ?? COMPATIBLE;
}
