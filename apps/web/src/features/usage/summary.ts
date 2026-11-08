// The usage page's numbers: the range a preset covers, the ledger's rows summed the ways the page
// shows them, and each provider's series color, which follows the provider whatever the filter.
import type { UsageRow } from "@/lib/api";
import { PROVIDERS } from "@/lib/providers";

export const RANGES = ["7d", "30d", "90d", "12m", "all"] as const;
export type RangeId = (typeof RANGES)[number];

export function isRange(value: string | null): value is RangeId {
  return (RANGES as readonly (string | null)[]).includes(value);
}

/** A local calendar day as the ledger writes it, YYYY-MM-DD. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseDay(key: string): Date {
  const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** The local midnight a range starts at, ms since the epoch; undefined for all of it. */
export function rangeStart(range: RangeId, now: Date): number | undefined {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (range) {
    case "7d":
      start.setDate(start.getDate() - 6);
      break;
    case "30d":
      start.setDate(start.getDate() - 29);
      break;
    case "90d":
      start.setDate(start.getDate() - 89);
      break;
    case "12m":
      start.setMonth(start.getMonth() - 11, 1);
      break;
    case "all":
      return undefined;
  }
  return start.getTime();
}

export type Granularity = "day" | "month";

export interface Bucket {
  /** YYYY-MM-DD for a day, YYYY-MM for a month. */
  readonly key: string;
  /** Its first local midnight. */
  readonly start: Date;
}

/** Longer than this, all time is drawn a month to a column. */
const MAX_DAYS = 92;

/** The chart's columns: each day of the range, or each month for a year, oldest first. */
export function bucketsOf(
  range: RangeId,
  rows: readonly Pick<UsageRow, "day">[],
  now: Date,
): { readonly granularity: Granularity; readonly buckets: Bucket[] } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startMs = rangeStart(range, now);
  let first: Date;
  if (startMs !== undefined) {
    first = new Date(startMs);
  } else {
    const earliest = rows.reduce<string | null>(
      (min, row) => (min === null || row.day < min ? row.day : min),
      null,
    );
    first = earliest === null || earliest > dayKey(today) ? today : parseDay(earliest);
  }
  const days = Math.round((today.getTime() - first.getTime()) / 86_400_000) + 1;
  const granularity: Granularity = range === "12m" || days > MAX_DAYS ? "month" : "day";
  const buckets: Bucket[] = [];
  if (granularity === "day") {
    for (const date = new Date(first); date <= today; date.setDate(date.getDate() + 1)) {
      buckets.push({ key: dayKey(date), start: new Date(date) });
    }
  } else {
    const last = new Date(today.getFullYear(), today.getMonth(), 1);
    for (
      const date = new Date(first.getFullYear(), first.getMonth(), 1);
      date <= last;
      date.setMonth(date.getMonth() + 1)
    ) {
      buckets.push({ key: dayKey(date).slice(0, 7), start: new Date(date) });
    }
  }
  return { granularity, buckets };
}

export function bucketKey(day: string, granularity: Granularity): string {
  return granularity === "day" ? day : day.slice(0, 7);
}

export interface Totals {
  readonly costUsd: number;
  readonly estimatedUsd: number;
  readonly unpriced: number;
  readonly records: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly characters: number;
  readonly audioSeconds: number;
  readonly images: number;
}

const SUMMED = [
  "costUsd",
  "estimatedUsd",
  "unpriced",
  "records",
  "inputTokens",
  "cachedTokens",
  "outputTokens",
  "characters",
  "audioSeconds",
  "images",
] as const satisfies readonly (keyof Totals)[];

const ZERO: Totals = Object.fromEntries(SUMMED.map((key) => [key, 0])) as unknown as Totals;

function plus(a: Totals, b: Totals): Totals {
  return Object.fromEntries(SUMMED.map((key) => [key, a[key] + b[key]])) as unknown as Totals;
}

export function totalsOf(rows: readonly Totals[]): Totals {
  return rows.reduce(plus, ZERO);
}

export interface Group<K> {
  readonly key: K;
  readonly totals: Totals;
}

/** Rows summed by `keyOf`, the costliest first, then the busiest. */
function groupBy<K>(
  rows: readonly UsageRow[],
  keyOf: (row: UsageRow) => K,
  id: (key: K) => string,
) {
  const groups = new Map<string, { key: K; totals: Totals }>();
  for (const row of rows) {
    const key = keyOf(row);
    const entry = groups.get(id(key));
    if (entry === undefined) groups.set(id(key), { key, totals: plus(ZERO, row) });
    else entry.totals = plus(entry.totals, row);
  }
  return [...groups.values()].sort(
    (a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.records - a.totals.records,
  ) as Group<K>[];
}

export function byProvider(rows: readonly UsageRow[]): Group<string>[] {
  return groupBy(
    rows,
    (row) => row.provider,
    (key) => key,
  );
}

export function byPersona(rows: readonly UsageRow[]): Group<string>[] {
  return groupBy(
    rows,
    (row) => row.persona,
    (key) => key,
  );
}

export interface ModelKey {
  readonly provider: string;
  readonly role: string;
  readonly model: string;
}

/** One line per model and the role it served: one model may chat and remember. */
export function byModel(rows: readonly UsageRow[]): Group<ModelKey>[] {
  return groupBy(
    rows,
    (row): ModelKey => ({ provider: row.provider, role: row.role, model: row.model }),
    (key) => `${key.provider}\n${key.role}\n${key.model}`,
  );
}

/** The categorical slots a chart colors, as index.css's --series-<n>. */
export const SLOTS = 8;
export const OTHER = "other";

/**
 * Each provider's slot, 1-based, from every provider the ledger knows in catalog order, so no
 * filter repaints one. Past the slots, the rest are drawn together as Other.
 */
export function seriesSlots(
  providers: readonly string[],
): ReadonlyMap<string, number | typeof OTHER> {
  const order = (id: string): number => {
    const index = PROVIDERS.findIndex((provider) => provider.id === id);
    return index === -1 ? PROVIDERS.length : index;
  };
  const sorted = [...new Set(providers)].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const named = sorted.length <= SLOTS ? SLOTS : SLOTS - 1;
  return new Map(sorted.map((id, index) => [id, index < named ? index + 1 : OTHER]));
}

export interface Series {
  /** A provider's id, or Other for the providers past the slots. */
  readonly id: string;
  readonly slot: number | typeof OTHER;
  /** The providers it sums: one, or Other's. */
  readonly providers: readonly string[];
}

export interface Column extends Bucket {
  /** USD by series id. */
  readonly values: Readonly<Record<string, number>>;
  readonly total: number;
}

/**
 * The chart: one column per bucket, each the spend of every series with any in the range, stacked
 * in slot order with Other on top.
 */
export function chartOf(
  rows: readonly UsageRow[],
  buckets: readonly Bucket[],
  granularity: Granularity,
  slots: ReadonlyMap<string, number | typeof OTHER>,
): { readonly series: Series[]; readonly columns: Column[] } {
  const seriesOf = (provider: string): string =>
    (slots.get(provider) ?? OTHER) === OTHER ? OTHER : provider;
  const members = new Map<string, Set<string>>();
  const values = new Map<string, Record<string, number>>();
  for (const row of rows) {
    if (row.costUsd <= 0) continue;
    const series = seriesOf(row.provider);
    let set = members.get(series);
    if (set === undefined) {
      set = new Set();
      members.set(series, set);
    }
    set.add(row.provider);
    const key = bucketKey(row.day, granularity);
    const column = values.get(key) ?? {};
    column[series] = (column[series] ?? 0) + row.costUsd;
    values.set(key, column);
  }
  const rank = (id: string): number => {
    const slot = id === OTHER ? OTHER : (slots.get(id) ?? OTHER);
    return slot === OTHER ? SLOTS + 1 : slot;
  };
  const series = [...members.entries()]
    .map(
      ([id, providers]): Series => ({
        id,
        slot: id === OTHER ? OTHER : (slots.get(id) ?? OTHER),
        providers: [...providers].sort(),
      }),
    )
    .sort((a, b) => rank(a.id) - rank(b.id));
  const columns = buckets.map((bucket): Column => {
    const column = values.get(bucket.key) ?? {};
    const total = Object.values(column).reduce((sum, value) => sum + value, 0);
    return { ...bucket, values: column, total };
  });
  return { series, columns };
}

/** Round axis ticks from zero past `max`, about `count` steps of 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw * (1 - 1e-9)) ?? raw;
  const steps = Math.ceil(max / step - 1e-9);
  return Array.from({ length: steps + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/** The decimals a tick step needs to tell its ticks apart. */
export function stepDecimals(step: number): number {
  if (!(step > 0) || step >= 1) return 0;
  const text = step.toPrecision(12).replace(/0+$/, "");
  return text.length - text.indexOf(".") - 1;
}
