// What a request cost, from the catalog's prices when the provider doesn't say.
import { type Category, modelInfo, type Price } from "./catalog.ts";

/** What a request used. Token counts are disjoint: `inputTokens` leaves out cache reads and writes. */
export interface Units {
  readonly inputTokens?: number;
  readonly cachedTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly characters?: number;
  readonly bytes?: number;
  readonly audioSeconds?: number;
  readonly searches?: number;
  readonly images?: number;
}

/** The model's price at `at` (ms since the epoch): its promotion's while one runs. */
export function priceOf(
  provider: string,
  category: Category,
  model: string,
  at: number = Date.now(),
): Price | undefined {
  const info = modelInfo(provider, category, model);
  if (info?.promo !== undefined && at < Date.parse(info.promo.until)) return info.promo.price;
  return info?.price;
}

const n = (value: number | undefined): number => (value !== undefined && value > 0 ? value : 0);

/** What `units` cost at `price`, in USD; null when they hold nothing the price charges for. */
export function costOf(price: Price, units: Units): number | null {
  switch (price.unit) {
    case "tokens": {
      const counted =
        units.inputTokens !== undefined ||
        units.outputTokens !== undefined ||
        units.cachedTokens !== undefined;
      if (!counted) return null;
      return (
        (n(units.inputTokens) * price.input +
          n(units.cachedTokens) * (price.cacheRead ?? price.input) +
          n(units.cacheWriteTokens) * (price.cacheWrite ?? price.input) +
          n(units.outputTokens) * price.output) /
        1_000_000
      );
    }
    case "characters":
      return units.characters === undefined ? null : (units.characters * price.usd) / 1_000_000;
    case "bytes":
      return units.bytes === undefined ? null : (units.bytes * price.usd) / 1_000_000;
    case "audio-hours":
      return units.audioSeconds === undefined ? null : (units.audioSeconds / 3600) * price.usd;
    case "searches":
      return units.searches === undefined ? null : (units.searches * price.usd) / 1000;
    case "images":
      return units.images === undefined ? null : units.images * price.usd;
  }
}

/** The units a text costs a TTS: characters as Unicode counts them, and UTF-8 bytes. */
export function textUnits(text: string): Pick<Units, "characters" | "bytes"> {
  let characters = 0;
  for (const _ of text) characters++;
  return { characters, bytes: new TextEncoder().encode(text).length };
}
