// What a ledger summary holds. The local app's API (apps/bot/src/local/api.ts) declares the same
// shapes for the web app, and its usage route holds the two in step.

/** One day's spend for one persona, role and model, summed. */
export interface UsageRow {
  /** The local calendar day of the machine that keeps the ledger, YYYY-MM-DD. */
  readonly day: string;
  readonly persona: string;
  readonly provider: string;
  readonly category: string;
  readonly role: string;
  readonly model: string;
  /** Records summed: a request each, or a batch of a call's audio or speech. */
  readonly records: number;
  /** USD, reported and estimated together. */
  readonly costUsd: number;
  /** The part of `costUsd` that is the catalog's estimate, not the provider's figure. */
  readonly estimatedUsd: number;
  /** Records no price covers, whose usage is counted but not costed. */
  readonly unpriced: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly characters: number;
  readonly audioSeconds: number;
  readonly images: number;
}

export interface UsageSummary {
  /** The range asked for, ms since the epoch; null for unbounded. */
  readonly from: number | null;
  readonly to: number | null;
  /** Whose rows these are; null for every persona. */
  readonly persona: string | null;
  readonly rows: readonly UsageRow[];
  /** Every persona with a record in the ledger, whatever the filter. */
  readonly personas: readonly string[];
  /** Every provider with a record in the ledger, whatever the filter. */
  readonly providers: readonly string[];
  /** The ledger's file, and false when it can't be written, so nothing is recorded. */
  readonly path: string;
  readonly recording: boolean;
}
