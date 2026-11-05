// The keys credentials.json holds, as the setup wizard and the settings page list them, and how a
// provider check's verdict is shown.
import type { CheckProvider, CheckResult, RequiredKey } from "@/lib/api";

/** The keys a call can't start without, in the order the wizard asks for them. */
export const REQUIRED: readonly RequiredKey[] = [
  "SONIOX_API_KEY",
  "OPENROUTER_API_KEY",
  "FISH_API_KEY",
];

/** Keys for other providers; without them those calls go through OpenRouter's key. */
export const OPTIONAL: readonly string[] = [
  "EMBED_API_KEY",
  "RERANK_API_KEY",
  "REFINE_API_KEY",
  "OPENAI_API_KEY",
];

/** Read only by a public deployment, so the local app never lists them. */
export const PRODUCTION_ONLY: readonly string[] = [
  "CLOUDFLARE_TURN_KEY_API_TOKEN",
  "WEBRTC_TURN_CREDENTIAL",
  "CF_WAF_BYPASS_TOKEN",
];

/** The provider check for a key; a key without one can only be saved. */
export const CHECK_OF: Readonly<Record<string, CheckProvider>> = {
  SONIOX_API_KEY: "soniox",
  OPENROUTER_API_KEY: "openrouter",
  FISH_API_KEY: "fish",
  EMBED_API_KEY: "embeddings",
  RERANK_API_KEY: "rerank",
  REFINE_API_KEY: "refine",
};

export interface KeyPages {
  /** Where to create the key. */
  readonly key: string;
  /** Where to add the credit it bills. */
  readonly credit: string;
}

export const KEY_PAGES: Readonly<Record<RequiredKey, KeyPages>> = {
  SONIOX_API_KEY: { key: "https://console.soniox.com/", credit: "https://console.soniox.com/" },
  OPENROUTER_API_KEY: {
    key: "https://openrouter.ai/settings/keys",
    credit: "https://openrouter.ai/settings/credits",
  },
  FISH_API_KEY: {
    key: "https://fish.audio/app/",
    credit: "https://fish.audio/app/developers/billing/",
  },
};

export type Tone = "ok" | "warn" | "error";

export function checkTone(result: Pick<CheckResult, "ok" | "warnings">): Tone {
  if (!result.ok) return "error";
  return result.warnings.length > 0 ? "warn" : "ok";
}

/**
 * The locale key for a check's code: the provider's own string, else the code's, else a plain
 * passed or failed (the server's English message then says the rest).
 */
export function verdictKey(
  provider: CheckProvider,
  result: { readonly ok: boolean; readonly code: string },
  has: (key: string) => boolean,
): string {
  const own = `settings.check.${provider}.${result.code}`;
  if (has(own)) return own;
  const shared = `settings.check.${result.code}`;
  if (has(shared)) return shared;
  return result.ok ? "settings.check.passed" : "settings.check.failed";
}

/** A warning's locale key, or null when only the server's English message describes it. */
export function warningKey(code: string, has: (key: string) => boolean): string | null {
  const key = `settings.check.warning.${code}`;
  return has(key) ? key : null;
}
