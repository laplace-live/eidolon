// What a refine run spent. OpenRouter reports each call's cost when the request sets
// `usage.include`; a call that reports none is estimated at the catalog's price.
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
import {
  billingProvider,
  type EmbeddingCostSource as CostSource,
  costOf,
  openaiUnits,
  type Price,
  priceOf,
  trySelect,
} from "@eidolon/providers";

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
 * The catalog's price for `model` where the refine role's requests go, as the ledger prices them;
 * undefined when it lists none there, as for OpenRouter's chat models, or the role won't resolve.
 */
export function refinePrice(model: string): Price | undefined {
  const selection = trySelect("refine");
  if (selection === null) return undefined;
  return priceOf(billingProvider(selection.provider.id, selection.baseUrl), "llm", model);
}

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

/**
 * A response's tokens and cost: reported, else estimated at `refinePrice`, its cache reads at
 * their own price, else neither.
 */
export function extractUsage(response: unknown, model: string): Usage {
  const raw = isPlainObject(response) ? response.usage : undefined;
  const usage = isPlainObject(raw) ? raw : {};
  const prompt = tokenCount(usage.prompt_tokens);
  const completion = tokenCount(usage.completion_tokens);
  const cost = extractCostUsd(usage);
  if (cost !== null) return usageOf(prompt, completion, cost, "openrouter");
  const price = refinePrice(model);
  const estimate = price === undefined ? null : costOf(price, openaiUnits(usage));
  if (estimate !== null) return usageOf(prompt, completion, estimate, "estimate");
  logger.warning(`No cost data and no pricing entry for ${pyRepr(model)}; reporting tokens only.`);
  return usageOf(prompt, completion, 0, "unknown");
}

/** `$0.0123`, marked `(estimate)` or `(mixed)` unless OpenRouter reported it all. */
export function fmtCost(usage: Usage): string {
  if (usage.costSource === "unknown") return "(not priced)";
  const note = usage.costSource === "openrouter" ? "" : ` (${usage.costSource})`;
  return `$${pyFixed(usage.costUsd, 4)}${note}`;
}
