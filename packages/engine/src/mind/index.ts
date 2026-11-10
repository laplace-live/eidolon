// The mind a persona's chat turn talks to: whichever provider fills her mind role in the persona
// scope it is made in, over @eidolon/providers' fetch clients.
import { openrouterHeaders } from "@eidolon/config";
import {
  ANTHROPIC_FALLBACK_MODELS,
  AnthropicClient,
  hasKey,
  missingKey,
  modelInfo,
  OpenAIChatClient,
  selectRequired,
  usageHook,
} from "@eidolon/providers";
import type { Mind } from "../types.ts";
import { AnthropicMind } from "./anthropic.ts";
import { type OpenAIDialect, OpenAIMind } from "./openai.ts";

/**
 * OpenAI's and xAI's reasoning models reject a request with `stop`
 * (https://platform.openai.com/docs/api-reference/chat/create#chat-create-stop,
 * https://docs.x.ai/docs/guides/reasoning).
 */
const REJECTS_STOP: ReadonlySet<string> = new Set(["openai", "xai"]);

function dialectOf(provider: string, model: string): OpenAIDialect {
  switch (provider) {
    case "openai":
      return "openai";
    case "deepseek":
      return "deepseek";
    case "google":
      return "gemini";
    case "openrouter":
      // pipedog's OpenRouter service sends Gemini's routes one system message, matched by name.
      return model.toLowerCase().includes("gemini") ? "gemini" : "compatible";
    default:
      return "compatible";
  }
}

/**
 * The persona's mind, as a call's createLlm would build it for the same settings. Throws when the
 * role's key is missing, before any request. Keep one for a whole turn, so a tool round can send
 * back what the round before it needs.
 */
export function createMind(): Mind {
  const selection = selectRequired("mind");
  if (!hasKey(selection)) throw missingKey(selection);
  const { apiKey, model, provider } = selection;
  const baseUrl = selection.baseUrl as string;
  const onUsage = usageHook("mind", provider.id);
  const live = modelInfo(provider.id, "llm", model)?.live ?? {};
  if (provider.id === "anthropic") {
    return new AnthropicMind({
      client: new AnthropicClient({ provider: provider.name, baseUrl, apiKey, onUsage }),
      model,
      extra: { ...live, ...(ANTHROPIC_FALLBACK_MODELS.has(model) ? { fallbacks: "default" } : {}) },
    });
  }
  const openrouter = provider.id === "openrouter";
  const client = new OpenAIChatClient({
    provider: provider.name,
    baseUrl,
    apiKey,
    headers: openrouter ? openrouterHeaders() : {},
    onUsage,
    ...(openrouter ? { extraBody: { usage: { include: true } }, reportsCost: true } : {}),
  });
  return new OpenAIMind({
    client,
    model,
    live,
    dialect: dialectOf(provider.id, model),
    takesStop: !REJECTS_STOP.has(provider.id),
  });
}
