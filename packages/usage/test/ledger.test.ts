import "../../config/test/isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, resetSettings, withPersona } from "@eidolon/config";
import { reportUsage, withUsageScope } from "@eidolon/providers";
import { installUsageLedger, ledgerPath, UsageLedger, uninstallUsageLedger } from "../src/index.ts";

const touched: string[] = [];
afterEach(() => {
  uninstallUsageLedger();
  for (const name of touched) delete process.env[name];
  touched.length = 0;
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

function at(iso: string): number {
  return Date.parse(iso);
}

const base = {
  source: "call" as const,
  session: "s1",
  role: "mind" as const,
  category: "llm" as const,
  provider: "openrouter",
  model: "m",
};

describe("UsageLedger", () => {
  test("sums each day's spend by persona, provider, role and model", () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-ledger-"));
    try {
      const ledger = new UsageLedger(join(dir, "usage.db"));
      const noon = at("2026-11-08T12:00:00");
      ledger.record(
        {
          ...base,
          at: noon,
          units: { inputTokens: 10, outputTokens: 2 },
          costUsd: 0.01,
          costSource: "reported",
        },
        "alice",
      );
      ledger.record(
        {
          ...base,
          at: noon + 1000,
          units: { inputTokens: 5 },
          costUsd: 0.02,
          costSource: "estimated",
        },
        "alice",
      );
      ledger.record(
        {
          ...base,
          role: "voice",
          category: "tts",
          provider: "cartesia",
          model: "sonic-3.6",
          at: noon,
          units: { characters: 40, bytes: 120 },
          costUsd: null,
          costSource: "unpriced",
        },
        "bob",
      );
      const all = ledger.summarize();
      expect(all.personas).toEqual(["alice", "bob"]);
      expect(all.rows).toEqual([
        {
          day: "2026-11-08",
          persona: "alice",
          provider: "openrouter",
          category: "llm",
          role: "mind",
          model: "m",
          records: 2,
          costUsd: 0.03,
          estimatedUsd: 0.02,
          unpriced: 0,
          inputTokens: 15,
          cachedTokens: 0,
          outputTokens: 2,
          characters: 0,
          audioSeconds: 0,
          images: 0,
        },
        expect.objectContaining({
          persona: "bob",
          provider: "cartesia",
          records: 1,
          costUsd: 0,
          unpriced: 1,
          characters: 40,
        }),
      ]);
      const bob = ledger.summarize({ persona: "bob" });
      expect(bob.rows.map((row) => row.persona)).toEqual(["bob"]);
      expect(bob.personas).toEqual(["alice", "bob"]);
      expect(bob.providers).toEqual(["cartesia", "openrouter"]);
      expect(ledger.summarize({ from: noon + 1, to: noon + 2000 }).rows[0]?.records).toBe(1);
      expect(ledger.summarize({ to: noon }).rows).toEqual([]);
      ledger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installUsageLedger", () => {
  test("records every report under the active persona, at <home>/usage.db by default", async () => {
    const ledger = installUsageLedger();
    expect(ledger?.path).toBe(join(dataHome(), "usage.db"));
    expect(ledgerPath()).toBe(join(dataHome(), "usage.db"));
    await withUsageScope({ source: "job", session: "j1" }, async () => {
      reportUsage({
        role: "refine",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        units: { inputTokens: 1_000_000 },
      });
    });
    const [row] = ledger?.summarize().rows ?? [];
    expect(row).toMatchObject({ persona: "milky-green", provider: "anthropic", costUsd: 2 });
    expect(statSync(join(dataHome(), "usage.db")).isFile()).toBe(true);
  });

  test("records a report under withPersona's persona, two scopes interleaved", async () => {
    for (const id of ["alice", "bob"]) {
      const folder = join(dataHome(), "personas", id);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "persona.yaml"), `identity:\n  name: ${id}\n`);
    }
    const ledger = installUsageLedger();
    const report = (model: string): void =>
      reportUsage({ role: "mind", provider: "openrouter", model, units: {}, costUsd: 0 });
    const aliceTurn = Promise.withResolvers<void>();
    const bobTurn = Promise.withResolvers<void>();
    await Promise.all([
      withPersona("alice", async () => {
        await aliceTurn.promise;
        report("alice-turn");
        bobTurn.resolve();
      }),
      withPersona("bob", async () => {
        report("bob-first");
        aliceTurn.resolve();
        await bobTurn.promise;
        report("bob-second");
      }),
    ]);
    report("outside");
    expect(withPersona("bob", installUsageLedger)).toBe(ledger);
    expect(ledger?.summarize().rows.map((row) => [row.persona, row.model])).toEqual([
      ["alice", "alice-turn"],
      ["bob", "bob-first"],
      ["bob", "bob-second"],
      ["milky-green", "outside"],
    ]);
  });

  test("a path that can't be opened leaves recording off, and reports cost nothing", () => {
    process.env.EIDOLON_USAGE_DB = "/dev/null/usage.db";
    touched.push("EIDOLON_USAGE_DB");
    expect(installUsageLedger()).toBeNull();
    expect(() =>
      reportUsage({ role: "mind", provider: "openrouter", model: "m", units: {} }),
    ).not.toThrow();
  });
});
