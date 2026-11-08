// GET /api/local/usage: the ledger's spend by day, persona, provider and model, filtered by range
// and persona, and an honest "not recording" when the ledger can't open.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, installSettings, resetSettings } from "@eidolon/config";
import { reportUsage, withUsageScope } from "@eidolon/providers";
import { installUsageLedger, uninstallUsageLedger } from "@eidolon/usage";
import type { UsageSummary } from "../../src/local/api.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot } from "./harness.ts";

let booted: Booted;
let logs: CapturedLogs;

function write(rel: string, text: string): void {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function usePersona(id: string): void {
  write("settings.yaml", `persona: ${id}\n`);
  resetSettings();
  installSettings();
}

beforeEach(async () => {
  logs = captureLogs();
  write("personas/alpha/persona.yaml", "identity:\n  name: Alpha\n");
  write("personas/beta/persona.yaml", "identity:\n  name: Beta\n");
  usePersona("alpha");
  booted = await bootFixture();
});

afterEach(async () => {
  uninstallUsageLedger();
  await booted.stop();
  logs.restore();
  cleanUpBoot();
});

async function usage(query = ""): Promise<{ status: number; body: UsageSummary }> {
  const response = await fetch(`${booted.base}/api/local/usage${query}`, {
    headers: booted.session,
  });
  return { status: response.status, body: (await response.json()) as UsageSummary };
}

function spend(provider: string, model: string, costUsd?: number): void {
  withUsageScope({ source: "call", session: "s1" }, () =>
    reportUsage({
      role: "mind",
      provider,
      model,
      units: { inputTokens: 1000, outputTokens: 10 },
      ...(costUsd === undefined ? {} : { costUsd }),
    }),
  );
}

describe("GET /api/local/usage", () => {
  test("sums what each persona spent, and filters by persona", async () => {
    installUsageLedger();
    spend("openrouter", "m", 0.25);
    usePersona("beta");
    spend("deepseek", "deepseek-flash");
    const all = await usage();
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({
      persona: null,
      personas: ["alpha", "beta"],
      providers: ["deepseek", "openrouter"],
      recording: true,
      path: join(dataHome(), "usage.db"),
    });
    expect(all.body.rows.map((row) => [row.persona, row.provider, row.costUsd > 0])).toEqual([
      ["alpha", "openrouter", true],
      ["beta", "deepseek", true],
    ]);
    const alpha = await usage("?persona=alpha");
    expect(alpha.body.rows.map((row) => row.provider)).toEqual(["openrouter"]);
    expect(alpha.body.rows[0]).toMatchObject({ costUsd: 0.25, estimatedUsd: 0, records: 1 });
    expect(alpha.body.providers).toEqual(["deepseek", "openrouter"]);
    // DeepSeek reports no cost, so the catalog's price estimates it.
    const beta = await usage("?persona=beta");
    expect(beta.body.rows[0]?.estimatedUsd).toBe(beta.body.rows[0]?.costUsd);
  });

  test("a range starting after every record holds none", async () => {
    installUsageLedger();
    spend("openrouter", "m", 0.25);
    const later = await usage(`?from=${Date.now() + 60_000}`);
    expect(later.body.rows).toEqual([]);
    expect(later.body.from).toBeGreaterThan(Date.now());
  });

  test("without a ledger, nothing is recorded and the page is told so", async () => {
    const { status, body } = await usage();
    expect(status).toBe(200);
    expect(body).toMatchObject({ rows: [], personas: [], providers: [], recording: false });
  });

  test("a range or persona that isn't one is refused", async () => {
    expect((await usage("?from=yesterday")).status).toBe(400);
    expect((await usage("?to=-1")).status).toBe(400);
    expect((await usage("?persona=..%2Fx")).status).toBe(400);
  });
});
