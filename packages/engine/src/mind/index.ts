// The mind a persona's chat turn talks to: whichever provider fills her mind role in the persona
// scope it is made in, over @eidolon/providers' fetch clients. A task's mind fills the assistant
// role instead.
import { accountProvider, openrouterHeaders } from "@eidolon/config";
import {
  ANTHROPIC_FALLBACK_MODELS,
  AnthropicClient,
  hasKey,
  installedSources,
  missingKey,
  modelInfo,
  OpenAIChatClient,
  roleById,
  type Sources,
  selectRequired,
  type UsageRecord,
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

/**
 * A task's reply cap on Anthropic, thinking included: the most every model Anthropic serves accepts
 * (Haiku 4.5, Sonnet 4.5 and Opus 4.5 stop at 64K, the rest at 128K), so one long `write` fits
 * (https://platform.claude.com/docs/en/build-with-claude/thinking#output-limits).
 */
const TASK_MAX_TOKENS = 64_000;

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

/** The settings as they stand, but with `account` and `model` filling `role`. */
function overridden(
  role: "mind" | "assistant",
  account: string | undefined,
  model: string | undefined,
): Sources | undefined {
  if (account === undefined && model === undefined) return undefined;
  const sources = installedSources();
  const { providerEnv, modelEnv, defaultProvider } = roleById(role);
  const providerOf = (id: string | null) =>
    id === null ? null : accountProvider(id.trim().toLowerCase(), sources.accounts);
  const own = sources.read(providerEnv)?.trim() || defaultProvider;
  const read = (name: string): string | undefined => {
    if (name === providerEnv) return account ?? sources.read(name);
    if (name !== modelEnv) return sources.read(name);
    if (model !== undefined) return model;
    // A model belongs to its provider: another provider's account doesn't take the role's.
    if (account !== undefined && providerOf(account) !== providerOf(own)) return undefined;
    return sources.read(name);
  };
  return { ...sources, read };
}

/**
 * The persona's mind, as a call's createLlm would build it for the same settings, or with
 * `role` "assistant" a task's. Throws when the role's account or key is missing, before any request.
 * Keep one for a whole turn, so a tool round can send back what the round before it needs.
 */
export function createMind(
  role: "mind" | "assistant" = "mind",
  options: {
    /** Hears each usage record its requests make, as the ledger gets it. */
    readonly tap?: (record: UsageRecord) => void;
    /** An account for this mind alone, in place of the role's. */
    readonly account?: string;
    /** A model for this mind alone, in place of the role's. */
    readonly model?: string;
  } = {},
): Mind {
  const selection = selectRequired(role, overridden(role, options.account, options.model));
  if (!hasKey(selection)) throw missingKey(selection);
  const { apiKey, model, provider } = selection;
  const baseUrl = selection.baseUrl as string;
  const onUsage = usageHook(role, provider.id, options.tap);
  const live = modelInfo(provider.id, "llm", model)?.live ?? {};
  if (provider.id === "anthropic") {
    return new AnthropicMind({
      client: new AnthropicClient({ provider: provider.name, baseUrl, apiKey, onUsage }),
      model,
      extra: { ...live, ...(ANTHROPIC_FALLBACK_MODELS.has(model) ? { fallbacks: "default" } : {}) },
      ...(role === "assistant" ? { maxTokens: TASK_MAX_TOKENS } : {}),
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
    provider: provider.id,
    model,
    live,
    dialect: dialectOf(provider.id, model),
    takesStop: !REJECTS_STOP.has(provider.id),
  });
}
