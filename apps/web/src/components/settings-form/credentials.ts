// A provider check's tone, and where a provider's key and credit live.
import type { CheckResult } from "@/lib/api";
import { providerById } from "@/lib/providers";

export interface KeyPages {
  /** Where to create the key. */
  readonly key: string | null;
  /** Where to add the credit it bills. */
  readonly credit: string | null;
}

/** Where to get a provider's key and pay for what it uses, as the provider names them. */
export function keyPages(provider: string): KeyPages | undefined {
  const entry = providerById(provider);
  if (entry === undefined || (entry.keyUrl === null && entry.billingUrl === null)) return undefined;
  return { key: entry.keyUrl, credit: entry.billingUrl };
}

export type Tone = "ok" | "warn" | "error";

export function checkTone(result: Pick<CheckResult, "ok" | "warnings">): Tone {
  if (!result.ok) return "error";
  return result.warnings.length > 0 ? "warn" : "ok";
}
