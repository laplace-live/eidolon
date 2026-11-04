// OpenRouter reads HTTP-Referer / X-Title to attribute traffic to a named app on its dashboard;
// without them calls land in an anonymous bucket. Every OpenAI-compatible provider we've pointed
// EMBED_BASE_URL or REFINE_BASE_URL at ignores the headers harmlessly.
import { envStr } from "./env.ts";

// Sent as X-OpenRouter-Categories, nudging OpenRouter toward providers whose content policy
// permits roleplay traffic.
const CATEGORY = "roleplay";

export function openrouterAppName(): string {
  return envStr("OPENROUTER_APP_NAME", "LAPLACE Live!");
}

export function openrouterAppUrl(): string {
  return envStr("OPENROUTER_APP_URL", "https://laplace.live/ai");
}

/** A fresh object of attribution and routing headers, safe to mutate. */
export function openrouterHeaders(): Record<string, string> {
  const name = openrouterAppName();
  return {
    "HTTP-Referer": openrouterAppUrl(),
    "X-Title": name,
    "X-OpenRouter-Title": name,
    "X-OpenRouter-Categories": CATEGORY,
  };
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * The best USD cost in an OpenRouter `usage` block.
 *
 * `usage.cost` is what OpenRouter billed, and is always 0 on BYOK requests since OpenRouter takes
 * no cut of the inference. `usage.cost_details.upstream_inference_cost` carries what the provider
 * charged, but only on BYOK chat requests: the embeddings endpoint reports `cost: 0` and nothing
 * else, so embedding callers fall back to client-side token estimation when this returns 0.
 * `null` means no cost data at all, which some non-OpenRouter providers return.
 */
export function extractCostUsd(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const block = usage as Record<string, unknown>;
  const cost = asNumber(block.cost);
  if (cost !== null && cost > 0) return cost;
  const details = block.cost_details;
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    const upstream = asNumber((details as Record<string, unknown>).upstream_inference_cost);
    if (upstream !== null) return upstream;
  }
  return cost;
}
