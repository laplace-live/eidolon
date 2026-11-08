import { describe, expect, test } from "bun:test";
import type { UsageRow } from "@/lib/api";
import {
  bucketsOf,
  byModel,
  byProvider,
  chartOf,
  dayKey,
  niceTicks,
  OTHER,
  rangeStart,
  seriesSlots,
  stepDecimals,
  totalsOf,
} from "./summary";

function row(fields: Partial<UsageRow>): UsageRow {
  return {
    day: "2026-11-08",
    persona: "milky-green",
    provider: "openrouter",
    category: "llm",
    role: "mind",
    model: "m",
    records: 1,
    costUsd: 0,
    estimatedUsd: 0,
    unpriced: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    characters: 0,
    audioSeconds: 0,
    images: 0,
    ...fields,
  };
}

const NOW = new Date(2026, 10, 8, 15, 30);

describe("ranges", () => {
  test("a range starts at local midnight, today included in its days", () => {
    expect(dayKey(new Date(rangeStart("7d", NOW) ?? 0))).toBe("2026-11-02");
    expect(dayKey(new Date(rangeStart("30d", NOW) ?? 0))).toBe("2026-10-10");
    expect(dayKey(new Date(rangeStart("12m", NOW) ?? 0))).toBe("2025-12-01");
    expect(rangeStart("all", NOW)).toBeUndefined();
  });

  test("days a column each, months for a year or a long history", () => {
    const week = bucketsOf("7d", [], NOW);
    expect(week.granularity).toBe("day");
    expect(week.buckets.map((bucket) => bucket.key)).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
    const year = bucketsOf("12m", [], NOW);
    expect(year.granularity).toBe("month");
    expect(year.buckets.map((bucket) => bucket.key).at(0)).toBe("2025-12");
    expect(year.buckets).toHaveLength(12);
    expect(bucketsOf("all", [row({ day: "2026-11-01" })], NOW).buckets).toHaveLength(8);
    const long = bucketsOf("all", [row({ day: "2026-01-15" })], NOW);
    expect(long.granularity).toBe("month");
    expect(long.buckets.map((bucket) => bucket.key).slice(0, 2)).toEqual(["2026-01", "2026-02"]);
    expect(bucketsOf("all", [], NOW).buckets.map((bucket) => bucket.key)).toEqual(["2026-11-08"]);
  });
});

describe("sums", () => {
  const rows = [
    row({ provider: "fish", role: "voice", model: "drama-3", costUsd: 0.5, characters: 900 }),
    row({ costUsd: 1, estimatedUsd: 0.25, inputTokens: 100 }),
    row({ role: "memory", costUsd: 0.25, records: 3 }),
    row({ provider: "cartesia", role: "voice", model: "sonic", unpriced: 2, records: 2 }),
  ];

  test("totals add every column", () => {
    expect(totalsOf(rows)).toMatchObject({
      costUsd: 1.75,
      estimatedUsd: 0.25,
      unpriced: 2,
      records: 7,
      characters: 900,
    });
  });

  test("providers and models rank by spend, then by records", () => {
    expect(byProvider(rows).map((group) => [group.key, group.totals.costUsd])).toEqual([
      ["openrouter", 1.25],
      ["fish", 0.5],
      ["cartesia", 0],
    ]);
    expect(byModel(rows).map((group) => `${group.key.provider}/${group.key.role}`)).toEqual([
      "openrouter/mind",
      "fish/voice",
      "openrouter/memory",
      "cartesia/voice",
    ]);
  });
});

describe("series", () => {
  test("a provider keeps its slot whatever the filter, in catalog order", () => {
    const slots = seriesSlots(["fish", "openrouter", "someone-else", "soniox"]);
    expect([...slots.entries()]).toEqual([
      ["openrouter", 1],
      ["soniox", 2],
      ["fish", 3],
      ["someone-else", 4],
    ]);
  });

  test("past eight providers, the rest are Other", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const slots = seriesSlots(ids);
    expect(slots.get("g")).toBe(7);
    expect(slots.get("h")).toBe(OTHER);
    expect(slots.get("i")).toBe(OTHER);
    expect(seriesSlots(ids.slice(0, 8)).get("h")).toBe(8);
  });

  test("columns stack each series' spend; one that spent nothing isn't drawn", () => {
    const slots = seriesSlots(["openrouter", "fish", "cartesia"]);
    const { buckets, granularity } = bucketsOf("7d", [], NOW);
    const rows = [
      row({ provider: "fish", costUsd: 0.5 }),
      row({ costUsd: 1 }),
      row({ day: "2026-11-07", costUsd: 2 }),
      row({ provider: "cartesia", unpriced: 1 }),
    ];
    const { series, columns } = chartOf(rows, buckets, granularity, slots);
    expect(series.map((entry) => [entry.id, entry.slot])).toEqual([
      ["openrouter", 1],
      ["fish", 2],
    ]);
    expect(columns.at(-1)).toMatchObject({ values: { openrouter: 1, fish: 0.5 }, total: 1.5 });
    expect(columns.at(-2)?.total).toBe(2);
    expect(columns.at(0)?.total).toBe(0);
  });
});

describe("axis", () => {
  test("ticks are round and reach past the tallest column", () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(3.7)).toEqual([0, 1, 2, 3, 4]);
    expect(niceTicks(0.09)).toEqual([0, 0.025, 0.05, 0.075, 0.1]);
    expect(niceTicks(8)).toEqual([0, 2, 4, 6, 8]);
  });

  test("a step's decimals", () => {
    expect([10, 1, 0.5, 0.025, 0.0025].map(stepDecimals)).toEqual([0, 0, 1, 3, 4]);
  });
});
