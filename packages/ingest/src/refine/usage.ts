// What a refine run spent. OpenRouter reports each call's cost when the request sets
// `usage.include`; a provider that reports none falls back to a local price table.
import {
  extractCostUsd,
  isPlainObject,
  logger,
  pyError,
  pyFixed,
  pyParseInt,
  pyRepr,
  pyTruthy,
} from "@eidolon/config";
import type { CostSource } from "@eidolon/retrieval";

/** Tokens and USD, summed per call, then per chunk, then per stream, in that order. */
export class Usage {
  promptTokens = 0;
  completionTokens = 0;
  costUsd = 0;
  costSource: CostSource = "unknown";

  add(other: Usage): void {
    this.promptTokens += other.promptTokens;
    this.completionTokens += other.completionTokens;
    this.costUsd += other.costUsd;
    // One estimated call marks the whole run, so its total is never taken for audit quality.
    if (other.costSource === "estimate" && this.costSource === "openrouter") {
      this.costSource = "mixed";
    } else if (this.costSource === "unknown") {
      this.costSource = other.costSource;
    }
  }
}

function usageOf(prompt: number, completion: number, cost: number, source: CostSource): Usage {
  const usage = new Usage();
  usage.promptTokens = prompt;
  usage.completionTokens = completion;
  usage.costUsd = cost;
  usage.costSource = source;
  return usage;
}

/**
 * USD per million input and output tokens, for when OpenRouter returns no cost. The default model
 * isn't listed, so a run on it that gets no cost reports tokens only.
 */
export const PRICING_USD_PER_1M: ReadonlyMap<string, readonly [number, number]> = new Map([
  ["google/gemini-2.0-flash-001", [0.1, 0.4]],
  ["google/gemini-flash-1.5", [0.075, 0.3]],
  ["google/gemini-flash-1.5-8b", [0.0375, 0.15]],
  ["google/gemini-flash-latest", [0.075, 0.3]],
  // OpenRouter's `~` prefix means "always the latest"; same pricing.
  ["~google/gemini-flash-latest", [0.075, 0.3]],
  ["google/gemini-2.5-flash-lite", [0.1, 0.4]],
  ["anthropic/claude-haiku-latest", [0.8, 4.0]],
  ["anthropic/claude-3-5-haiku-20241022", [0.8, 4.0]],
  ["anthropic/claude-3-5-haiku-latest", [0.8, 4.0]],
  ["openai/gpt-4o-mini", [0.15, 0.6]],
  ["openai/gpt-4o-mini-2024-07-18", [0.15, 0.6]],
  ["openai/gpt-5-nano", [0.05, 0.4]],
  ["deepseek/deepseek-chat-v3.1", [0.27, 1.1]],
]);

/** `int(value or 0)` for a token count. */
function tokenCount(value: unknown): number {
  if (!pyTruthy(value)) return 0;
  if (value === true) return 1;
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = pyParseInt(value);
    if (parsed !== null) return parsed;
    throw pyError("ValueError", `invalid literal for int() with base 10: ${pyRepr(value)}`);
  }
  throw pyError(
    "TypeError",
    "int() argument must be a string, a bytes-like object or a real number",
  );
}

/** `_extract_usage`: a response's tokens and cost, reported, estimated, or neither. */
export function extractUsage(response: unknown, model: string): Usage {
  const raw = isPlainObject(response) ? response.usage : undefined;
  const usage = isPlainObject(raw) ? raw : {};
  const prompt = tokenCount(usage.prompt_tokens);
  const completion = tokenCount(usage.completion_tokens);
  const cost = extractCostUsd(usage);
  if (cost !== null) return usageOf(prompt, completion, cost, "openrouter");
  const pricing = PRICING_USD_PER_1M.get(model);
  if (pricing !== undefined) {
    const estimate = (prompt * pricing[0] + completion * pricing[1]) / 1_000_000;
    return usageOf(prompt, completion, estimate, "estimate");
  }
  logger.warning(
    `No cost data and no pricing entry for ${pyRepr(model)}; reporting tokens only. ` +
      "Add it to PRICING_USD_PER_1M to fix.",
  );
  return usageOf(prompt, completion, 0, "unknown");
}

/** `$0.0123`, marked `(estimate)` or `(mixed)` unless OpenRouter reported it all. */
export function fmtCost(usage: Usage): string {
  if (usage.costSource === "unknown") return "(not priced)";
  const note = usage.costSource === "openrouter" ? "" : ` (${usage.costSource})`;
  return `$${pyFixed(usage.costUsd, 4)}${note}`;
}
