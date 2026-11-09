import "../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, installSettings, PyFloat, resetSettings } from "@eidolon/config";
import { setUsageSink, type UsageRecord } from "@eidolon/providers";
import {
  ask,
  type GateRow,
  gateDecisionsMain,
  median,
  quantilesExclusive,
  runGateDecisions,
  summarize,
  turnMessages,
} from "../src/index.ts";
import { blockNetwork, captureIo, FIX, golden, setEnv } from "./helpers.ts";

blockNetwork();

interface Run {
  turns: string;
  env: Record<string, string> | null;
  fail_on: string | null;
  code: number;
  crash: [string, string] | null;
  stdout: string;
  decisions: string | null;
  requests: { url: string; auth: string; body: string }[];
}

interface Stats {
  data: number[];
  median: number;
  q10: number[];
  q4: number[];
}

const ANSWERS: Record<string, string> = await Bun.file(join(FIX, "gate/answers.json")).json();
// The fake clock's steps in milliseconds, which the goldens' latencies follow.
const STEPS = [460.9375, 250, 125, 527.34375, 0.9765625, 1500];
const goldens = await golden<{ runs: Run[]; stats: Stats[] }>("gate_decisions.json");

let work = "";
let restoreEnv = () => {};
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "cli-gate-"));
  restoreEnv = setEnv({ OPENROUTER_API_KEY: undefined, RETRIEVAL_GATE_MODEL: undefined });
});
afterEach(() => {
  restoreEnv();
  rmSync(work, { recursive: true, force: true });
});

/** Jev answering from the fixture by the turn's latest viewer line; one turn may get a 401. */
function fakeJev(failOn: string | null) {
  const requests: Run["requests"] = [];
  const jev = (async (url: string, init: RequestInit) => {
    const body = String(init.body);
    requests.push({
      url,
      auth: (init.headers as Record<string, string>).Authorization as string,
      body,
    });
    const text = JSON.parse(body).state.viewer_latest_message as string;
    if (text === failOn) {
      return new Response('{"error": "nope"}', { status: 401, statusText: "Unauthorized" });
    }
    return new Response(ANSWERS[text], { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: jev, requests };
}

function steppingClock(): () => number {
  let clock = 0;
  let ticks = 0;
  return () => {
    clock += STEPS[ticks++ % STEPS.length] as number;
    return clock;
  };
}

describe("decisions.py parity", () => {
  for (const run of goldens.runs) {
    test(`${run.turns} env=${JSON.stringify(run.env)} fail_on=${run.fail_on}`, async () => {
      Object.assign(process.env, run.env ?? { OPENROUTER_API_KEY: "sk-test" });
      const turnsPath = join(work, "turns.toml");
      const outPath = join(work, "decisions.json");
      copyFileSync(join(FIX, "gate", run.turns), turnsPath);
      const { fetch, requests } = fakeJev(run.fail_on);
      const io = captureIo();
      let code: number;
      let crash: [string, string] | null = null;
      try {
        code = await runGateDecisions({
          ...io.io,
          turnsPath,
          outPath,
          fetch,
          now: steppingClock(),
        });
      } catch (error) {
        code = 1;
        crash = [(error as Error).name, (error as Error).message];
      }
      expect({
        code,
        crash,
        stdout: io.stdout(),
        decisions: existsSync(outPath) ? readFileSync(outPath, "utf8") : null,
        requests,
      }).toEqual({
        code: run.code,
        crash: run.crash,
        stdout: run.stdout,
        decisions: run.decisions,
        requests: run.requests,
      });
    });
  }

  test("statistics.median and statistics.quantiles", () => {
    for (const s of goldens.stats) {
      expect(median(s.data)).toBe(s.median);
      expect(quantilesExclusive(s.data, 10)).toEqual(s.q10);
      expect(quantilesExclusive(s.data, 4)).toEqual(s.q4);
    }
    expect(() => median([])).toThrow("no median for empty data");
    expect(() => quantilesExclusive([], 10)).toThrow("must have at least one data point");
  });
});

test("turnMessages alternates the history, viewer first, then the turn", () => {
  expect(turnMessages({ text: "它几岁了？", before: ["你家猫叫什么", "叫坚果"] })).toEqual([
    { role: "user", content: "你家猫叫什么" },
    { role: "assistant", content: "叫坚果" },
    { role: "user", content: "它几岁了？" },
  ]);
});

test("summarize counts by label and keeps the first of equal extremes", () => {
  const row = (recall: boolean | null, score: number | PyFloat): GateRow => ({
    set: "dev",
    text: "t",
    recall,
    score,
    nouls: {},
    ms: 1,
    model: "m",
  });
  const one = new PyFloat(1);
  const summary = summarize([
    row(true, one),
    row(true, 1),
    row(false, 0.3),
    row(false, 0.1),
    row(null, 0),
  ]);
  expect(summary).toEqual({
    recall_kept: "2/2",
    chit_chat_skipped: "1/2",
    lowest_recall_score: one,
    highest_chit_chat_score: 0.3,
  });
});

test("ask raises on a malformed answer rather than failing open", async () => {
  const malformed = (async () =>
    new Response('{"answers": {"about_her": {"noul": null}}, "model": "m"}', {
      status: 200,
    })) as unknown as typeof globalThis.fetch;
  const options = { model: "m", headers: {}, fetch: malformed, now: () => 0 };
  await expect(ask({ text: "x" }, options)).rejects.toThrow("noul is not a number: None");
});

test("the command ignores its arguments, as decisions.py does", async () => {
  process.env.OPENROUTER_API_KEY = "sk-test";
  const turnsPath = join(work, "turns.toml");
  copyFileSync(join(FIX, "gate/turns_one.toml"), turnsPath);
  const { fetch, requests } = fakeJev(null);
  const code = await gateDecisionsMain(["--help"], {
    ...captureIo().io,
    turnsPath,
    outPath: join(work, "decisions.json"),
    fetch,
    now: steppingClock(),
  });
  expect(code).toBe(0);
  expect(requests).toHaveLength(2);
});

test("a key the local app saved in OpenRouter's account asks Jev too", async () => {
  const credentials = join(dataHome(), "credentials.json");
  mkdirSync(dataHome(), { recursive: true });
  writeFileSync(
    credentials,
    JSON.stringify({ accounts: { openrouter: { provider: "openrouter", apiKey: "sk-saved" } } }),
    { mode: 0o600 },
  );
  installSettings();
  try {
    const turnsPath = join(work, "turns.toml");
    copyFileSync(join(FIX, "gate/turns_one.toml"), turnsPath);
    const { fetch, requests } = fakeJev(null);
    const code = await gateDecisionsMain([], {
      ...captureIo().io,
      turnsPath,
      outPath: join(work, "decisions.json"),
      fetch,
      now: steppingClock(),
    });
    expect([code, [...new Set(requests.map((request) => request.auth))]]).toEqual([
      0,
      ["Bearer sk-saved"],
    ]);
  } finally {
    rmSync(credentials, { force: true });
    resetSettings();
  }
});

test("a turn without text raises KeyError, as decisions.py's turn['text'] does", async () => {
  const options = { model: "m", headers: {}, fetch: fakeJev(null).fetch, now: () => 0 };
  await expect(ask({ set: "dev" } as never, options)).rejects.toThrow("'text'");
});

test("a redirect is not followed and raises httpx's message", async () => {
  const redirect = (async () =>
    new Response(null, {
      status: 302,
      statusText: "Found",
      headers: { location: "https://example.com/next" },
    })) as unknown as typeof globalThis.fetch;
  const options = { model: "m", headers: {}, fetch: redirect, now: () => 0 };
  await expect(ask({ text: "x" }, options)).rejects.toThrow(
    "Redirect response '302 Found' for url 'https://openrouter.ai/api/alpha/decisions'\n" +
      "Redirect location: 'https://example.com/next'\n" +
      "For more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/302",
  );
});

test("each answer's usage goes into the ledger as the gate's", async () => {
  const records: UsageRecord[] = [];
  setUsageSink((record) => records.push(record));
  try {
    const answer = (async () =>
      Response.json({
        answers: { about_her: { noul: 0.7 } },
        model: "typesafe/jev-1.14",
        usage: { input_tokens: 120, output_tokens: 3, cost: 0.0002 },
      })) as unknown as typeof globalThis.fetch;
    await ask(
      { text: "x" },
      { model: "~typesafe/jev-latest", headers: {}, fetch: answer, now: () => 0 },
    );
    expect(
      records.map(({ role, provider, model, units, costUsd }) => ({
        role,
        provider,
        model,
        units,
        costUsd,
      })),
    ).toEqual([
      {
        role: "gate",
        provider: "openrouter",
        model: "typesafe/jev-1.14",
        units: { inputTokens: 120, outputTokens: 3 },
        costUsd: 0.0002,
      },
    ]);
  } finally {
    setUsageSink(null);
  }
});
