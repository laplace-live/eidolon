import { afterEach, describe, expect, test } from "bun:test";
import {
  billingProvider,
  costOf,
  priceOf,
  reportUsage,
  setUsageSink,
  stripMarkup,
  textUnits,
  type UsageRecord,
  usageRecord,
  withUsageScope,
} from "../src/index.ts";

describe("costOf", () => {
  test("tokens: input, cache reads and writes, and output at their own prices", () => {
    const price = { unit: "tokens", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } as const;
    expect(
      costOf(price, {
        inputTokens: 1_000_000,
        cachedTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(29.2, 10);
    expect(costOf({ unit: "tokens", input: 1, output: 2 }, { cachedTokens: 1_000_000 })).toBe(1);
    expect(costOf(price, { characters: 5 })).toBeNull();
  });

  test("audio by the hour, text by the million, searches by the thousand, images each", () => {
    expect(costOf({ unit: "audio-hours", usd: 0.12 }, { audioSeconds: 1800 })).toBeCloseTo(0.06);
    expect(costOf({ unit: "bytes", usd: 15 }, { bytes: 3_000 })).toBeCloseTo(0.045);
    expect(costOf({ unit: "characters", usd: 40 }, { characters: 1000 })).toBeCloseTo(0.04);
    expect(costOf({ unit: "searches", usd: 2 }, { searches: 1 })).toBeCloseTo(0.002);
    expect(costOf({ unit: "images", usd: 0.04 }, { images: 2 })).toBeCloseTo(0.08);
    expect(costOf({ unit: "audio-hours", usd: 0.12 }, {})).toBeNull();
  });
});

test("a promotion's price holds until its end", () => {
  const before = Date.parse("2026-11-30T00:00:00Z");
  const after = Date.parse("2026-12-02T00:00:00Z");
  expect(priceOf("fish", "tts", "drama-3", before)).toEqual({ unit: "bytes", usd: 10 });
  expect(priceOf("fish", "tts", "drama-3", after)).toEqual({ unit: "bytes", usd: 50 });
  expect(priceOf("fish", "tts", "no-such-model", after)).toBeUndefined();
});

test("textUnits counts code points and UTF-8 bytes", () => {
  expect(textUnits("你好a😀")).toEqual({ characters: 4, bytes: 3 + 3 + 1 + 4 });
});

describe("usage records", () => {
  afterEach(() => setUsageSink(null));

  test("a reported cost wins, else the catalog's estimate, else unpriced", () => {
    const at = Date.parse("2027-01-01T00:00:00Z");
    const base = { role: "voice", provider: "fish", model: "drama-3" } as const;
    expect(usageRecord({ ...base, units: { bytes: 1_000_000 }, costUsd: 0.5 }, at)).toMatchObject({
      category: "tts",
      costUsd: 0.5,
      costSource: "reported",
    });
    expect(usageRecord({ ...base, units: { bytes: 1_000_000 } }, at)).toMatchObject({
      costUsd: 50,
      costSource: "estimated",
    });
    expect(usageRecord({ ...base, model: "custom", units: { bytes: 9 } }, at)).toMatchObject({
      costUsd: null,
      costSource: "unpriced",
    });
  });

  test("a snapshot the provider answers with is priced as the model asked for", () => {
    const at = Date.parse("2027-01-01T00:00:00Z");
    const chat = { role: "mind", provider: "anthropic" } as const;
    const units = { inputTokens: 1_000_000 };
    expect(
      usageRecord(
        { ...chat, model: "claude-sonnet-5-5-20261101", requested: "claude-sonnet-5-5", units },
        at,
      ),
    ).toMatchObject({ model: "claude-sonnet-5-5-20261101", costUsd: 2, costSource: "estimated" });
    expect(usageRecord({ ...chat, model: "claude-sonnet-5-5-20261101", units }, at)).toMatchObject({
      costSource: "unpriced",
    });
    expect("requested" in usageRecord({ ...chat, model: "m", requested: "r", units }, at)).toBe(
      false,
    );
  });

  test("a model on your own machine costs nothing, whatever its name", () => {
    const local = { role: "mind", provider: "ollama", model: "my-tune" } as const;
    expect(usageRecord({ ...local, units: {} })).toMatchObject({
      costUsd: 0,
      costSource: "estimated",
    });
  });

  test("a scope names the source and session of everything it runs", async () => {
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    const report = () =>
      reportUsage({
        role: "mind",
        provider: "openrouter",
        model: "m",
        units: { inputTokens: 1 },
        costUsd: 0,
      });
    report();
    await withUsageScope({ source: "call", session: "s1" }, async () => {
      await Promise.resolve();
      report();
    });
    expect(records.map((r) => [r.source, r.session])).toEqual([
      [null, null],
      ["call", "s1"],
    ]);
  });

  test("a sink that throws costs the record, never the request", () => {
    setUsageSink(() => {
      throw new Error("disk full");
    });
    expect(() =>
      reportUsage({
        role: "mind",
        provider: "openrouter",
        model: "m",
        units: {},
      }),
    ).not.toThrow();
  });
});

test("spend is the provider's whose API the request went to, else the account's", () => {
  expect(billingProvider("openrouter", "https://api.cohere.com/v1")).toBe("cohere");
  expect(billingProvider("openrouter", "https://api.openai.com/v1/")).toBe("openai");
  expect(billingProvider("openrouter", "https://openrouter.ai/api/v1")).toBe("openrouter");
  expect(billingProvider("openrouter", "https://proxy.example/v1")).toBe("openrouter");
  expect(billingProvider("openai-compatible", "http://localhost:11434/v1")).toBe("ollama");
  expect(billingProvider("openai-compatible", "http://localhost:1234/v1")).toBe(
    "openai-compatible",
  );
  expect(billingProvider("openrouter", undefined)).toBe("openrouter");
  expect(billingProvider("openrouter", "not a url")).toBe("openrouter");
});

describe("stripMarkup", () => {
  const reply = "[温柔地] 嗯，<emphasis>真的</emphasis>好啊 [chuckling] 嘿嘿";

  test("Drama 3 keeps every cue", () => {
    expect(stripMarkup(reply, "fish-drama")).toBe(reply);
  });

  test("a bracket-reading model keeps the brackets and loses the word tags", () => {
    expect(stripMarkup(reply, "brackets")).toBe("[温柔地] 嗯，真的好啊 [chuckling] 嘿嘿");
  });

  test("any other model gets plain words", () => {
    expect(stripMarkup(reply, undefined)).toBe("嗯，真的好啊 嘿嘿");
    expect(stripMarkup("没有提示。", undefined)).toBe("没有提示。");
  });
});
