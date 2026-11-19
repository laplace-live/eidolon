// A task's meter: the spend its mind's usage records add up to, and why a request went uncounted.
import { logger } from "@eidolon/config";
import type { UsageRecord } from "@eidolon/providers";
import type { TaskMeter } from "../task.ts";

export interface UsageMeterOptions {
  /** The account and model the task's mind runs on, which a request with no usage names. */
  readonly account: string;
  readonly model: string;
  /** The task's spend before this meter. Default 0. */
  readonly spentUsd?: number;
}

/** A TaskMeter fed through `tap`, the tap createMind takes. */
export class UsageMeter implements TaskMeter {
  readonly #account: string;
  readonly #model: string;
  #spent: number;
  #input: number | null = null;
  /** Records since the last request ended. */
  #records = 0;
  #uncounted: string | null = null;

  constructor(options: UsageMeterOptions) {
    this.#account = options.account;
    this.#model = options.model;
    this.#spent = options.spentUsd ?? 0;
  }

  readonly tap = (record: UsageRecord): void => {
    this.#records++;
    if (record.costUsd !== null) this.#spent += record.costUsd;
    else this.#cannotCount(`No price is known for ${record.model} at ${record.provider}`);
    // The context's size: what the provider read from its cache counts as much as the rest.
    const { inputTokens, cachedTokens, cacheWriteTokens } = record.units;
    const counted = [inputTokens, cachedTokens, cacheWriteTokens].filter((n) => n !== undefined);
    this.#input = counted.length === 0 ? null : counted.reduce((sum, n) => sum + n, 0);
  };

  /**
   * A record of the task's that isn't one of its mind's requests, such as a web search: it adds to
   * the spend, but it is neither the context's size nor what the next request reported, so a
   * request that reports no usage still counts as one that couldn't be counted.
   */
  readonly charge = (record: UsageRecord): void => {
    if (record.costUsd !== null) this.#spent += record.costUsd;
    else this.#cannotCount(`No price is known for ${record.model} at ${record.provider}`);
  };

  requestEnded(): void {
    // A server may ignore the request for usage (stream_options.include_usage).
    if (this.#records === 0) {
      this.#input = null;
      this.#cannotCount(`No usage was reported for ${this.#model} at ${this.#account}`);
    }
    this.#records = 0;
  }

  spentUsd(): number {
    return this.#spent;
  }

  lastInputTokens(): number | null {
    return this.#input;
  }

  unpriced(): string | null {
    return this.#uncounted;
  }

  #cannotCount(why: string): void {
    if (this.#uncounted !== null) return;
    this.#uncounted = why;
    logger.warning(`${why}, so the task's spend pauses can't count it`);
  }
}
