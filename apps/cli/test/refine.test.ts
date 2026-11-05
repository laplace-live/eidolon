// fixtures/goldens/refine.json is what fixtures/refine/golden.py printed (`uv run --offline
// --no-sync python` from the repository root, then formatted by Biome): tools/refine.py's
// main_async over fixtures/refine/streams, answered by fixtures/refine/responses.json. Each
// scenario replays here through refineMain with the same responses, clock and date.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activePersona, sortedPy, sourceFolder } from "@eidolon/config";
import { acquireLock, refine, sourcesLockKey } from "@eidolon/ingest";
import { parseRefineArgs, refineMain } from "../src/refine.ts";
import { blockNetwork, captureIo, captureLogs, FIX, golden, placehold, setEnv } from "./helpers.ts";

blockNetwork();

interface Canned {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly content?: string;
  readonly finish_reason?: string;
  readonly usage?: unknown;
}

interface SeenRequest {
  readonly url: string;
  readonly headers: Record<string, string | null>;
  readonly sha256: string;
  readonly body: unknown;
}

interface Scenario {
  readonly name: string;
  readonly responses: string | null;
  readonly argv: string[];
  readonly exit_code: number;
  readonly stdout: string;
  readonly logs: [string, string][];
  readonly requests: SeenRequest[];
  readonly unused_responses: number;
  readonly sidecars: Record<string, string>;
  readonly files: string[];
}

const STREAMS = join(FIX, "refine/streams");
const RESPONSES = (await Bun.file(join(FIX, "refine/responses.json")).json()) as Record<
  string,
  Canned[]
>;
const HEADERS = [
  "authorization",
  "content-type",
  "accept",
  "http-referer",
  "x-title",
  "x-openrouter-title",
  "x-openrouter-categories",
];
const FIXED_NOW = () => new Date("2026-01-09T12:00:00Z");
const FIXED_CLOCK = () => 100;

function completion(entry: Canned): Response {
  const headers = { "content-type": "application/json", ...entry.headers };
  const body =
    entry.json !== undefined
      ? entry.json
      : {
          id: "gen-test",
          object: "chat.completion",
          created: 1767225600,
          model: "test/model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: entry.content },
              finish_reason: entry.finish_reason,
            },
          ],
          usage: entry.usage,
        };
  return new Response(JSON.stringify(body), { status: entry.status, headers });
}

/** Records each request as golden.py does, and answers from `entries` in order. */
function cannedFetch(
  entries: readonly Canned[],
  seen: SeenRequest[],
): { fetch: typeof fetch; left: () => number } {
  const queue = [...entries];
  const prompts = refine.refinePrompts({ name: "明前奶绿", shortName: "奶绿" });
  const placeholders = new Map([
    [prompts.extractSystem, "<EXTRACT_SYSTEM_PROMPT>"],
    [prompts.synthesizeSystem, "<SYNTHESIZE_SYSTEM_PROMPT>"],
  ]);
  const fake = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const raw = init?.body as string;
    const body = JSON.parse(raw) as {
      messages: { content: string }[];
      response_format: unknown;
    };
    const system = body.messages[0] as { content: string };
    system.content = placeholders.get(system.content) ?? system.content;
    const format = body.response_format as { json_schema: { name: string } };
    body.response_format = `<${format.json_schema.name}>`;
    const sent = Object.fromEntries(
      Object.entries(init?.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    seen.push({
      url: String(input),
      headers: Object.fromEntries(HEADERS.map((name) => [name, sent[name] ?? null])),
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      body,
    });
    const entry = queue.shift();
    if (entry === undefined) {
      return new Response(JSON.stringify({ error: "no canned response left" }), { status: 418 });
    }
    return completion(entry);
  };
  return { fetch: fake as unknown as typeof fetch, left: () => queue.length };
}

let work = "";
let streams = "";
let logs!: ReturnType<typeof captureLogs>;
let restoreEnv: () => void = () => {};
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "cli-refine-"));
  streams = join(work, "streams");
  cpSync(STREAMS, streams, { recursive: true });
  // As golden.py writes it: not JSON, so refine starts the stream afresh.
  writeFileSync(join(streams, "2026-01-05-BV1ddddddddd.refined.json"), "{not json");
  logs = captureLogs();
  restoreEnv = setEnv({
    OPENROUTER_API_KEY: "test-key",
    REFINE_API_KEY: undefined,
    REFINE_MODEL: undefined,
    REFINE_CONCURRENCY: undefined,
    REFINE_BASE_URL: undefined,
    OPENROUTER_APP_NAME: undefined,
    OPENROUTER_APP_URL: undefined,
  });
});
afterEach(() => {
  restoreEnv();
  logs.stop();
  rmSync(work, { recursive: true, force: true });
});

function sidecars(dir: string): Record<string, string> {
  return Object.fromEntries(
    sortedPy(readdirSync(dir).filter((name) => name.endsWith(".refined.json"))).map((name) => [
      name,
      readFileSync(join(dir, name), "utf8"),
    ]),
  );
}

const golden_ = await golden<{ printed_by: string; scenarios: Scenario[] }>("refine.json");

const COMPLETION = /^ {2}✓ /;

/**
 * The completion lines, then the rest, each in order. Python logs a completion when asyncio gets
 * round to as_completed's consumer, so where those lines fall among the next chunk's own lines is
 * up to each runtime's scheduler.
 */
function byKind(records: readonly (readonly string[])[]): [string[][], string[][]] {
  const done = records.filter(([, message]) => COMPLETION.test(message as string));
  const rest = records.filter(([, message]) => !COMPLETION.test(message as string));
  return [done.map((r) => [...r]), rest.map((r) => [...r])];
}

describe("replays refine.py's run over the synthetic transcripts", () => {
  for (const scenario of golden_.scenarios) {
    test(scenario.name, async () => {
      const seen: SeenRequest[] = [];
      const canned = cannedFetch(
        scenario.responses ? (RESPONSES[scenario.responses] as Canned[]) : [],
        seen,
      );
      const io = captureIo();
      const argv = scenario.argv.map((arg) => arg.replace("<DIR>", streams));
      const code = await refineMain(argv, {
        ...io.io,
        fetch: canned.fetch,
        now: FIXED_NOW,
        monotonic: FIXED_CLOCK,
      });
      const paths = { "<DIR>": streams };
      expect(placehold(io.stdout(), paths)).toBe(scenario.stdout);
      expect(io.stderr()).toBe("");
      const records = logs.records.map(([level, message]) => [level, placehold(message, paths)]);
      expect(byKind(records)).toEqual(byKind(scenario.logs));
      expect(seen).toEqual(scenario.requests);
      expect(canned.left()).toBe(scenario.unused_responses);
      expect(sidecars(streams)).toEqual(scenario.sidecars);
      expect(sortedPy(readdirSync(streams))).toEqual(scenario.files);
      expect(code).toBe(scenario.exit_code);
    });
  }
});

const USAGE_LINE = "usage: laplace-refine [-h] [--streams-dir STREAMS_DIR] [--model MODEL]\n";

describe("arguments", () => {
  test("-h prints Python's help with the persona and --json flags", async () => {
    const io = captureIo();
    expect(await refineMain(["-h"], io.io)).toBe(0);
    expect(io.stdout()).toStartWith(USAGE_LINE);
    expect(io.stdout()).toContain("\n  --persona PERSONA     Persona whose transcripts to refine");
    expect(io.stdout()).toContain("\n  --json                Write progress events to stdout");
  });

  test("--concurrency below 1 is a usage error, from the flag or the environment", async () => {
    for (const value of ["0", "-3"]) {
      const io = captureIo();
      expect(await refineMain(["--concurrency", value, "--dry-run"], io.io)).toBe(2);
      expect(io.stderr()).toEndWith(
        `laplace-refine: error: argument --concurrency: must be at least 1, not ${value}\n`,
      );
    }
    const io = captureIo();
    expect(await refineMain(["--concurrency", "x"], io.io)).toBe(2);
    expect(io.stderr()).toEndWith("error: argument --concurrency: invalid int value: 'x'\n");

    const restore = setEnv({ REFINE_CONCURRENCY: "0" });
    try {
      const env = captureIo();
      expect(await refineMain(["--dry-run"], env.io)).toBe(2);
      expect(env.stderr()).toEndWith(
        "laplace-refine: error: REFINE_CONCURRENCY must be at least 1, not 0\n",
      );
    } finally {
      restore();
    }
  });

  test("a blank REFINE_MODEL means the default; an explicit empty --model is sent as is", async () => {
    const restore = setEnv({ REFINE_MODEL: "" });
    try {
      const io = captureIo();
      expect(await refineMain(["--dry-run", "--streams-dir", streams], io.io)).toBe(0);
      expect(io.stdout()).toContain("Dry run — model: ~google/gemini-pro-latest  (two-pass");
      const empty = captureIo();
      expect(
        await refineMain(["--dry-run", "--streams-dir", streams, "--model", ""], empty.io),
      ).toBe(0);
      expect(empty.stdout()).toContain("Dry run — model:   (two-pass");
      expect(empty.stdout()).toContain("(model '' not in local price table; estimate is $0)");
    } finally {
      restore();
    }
  });

  test("the transcripts default to the persona's sources; an explicit folder wins", () => {
    const args = parseRefineArgs(["--persona", "milky-green"]);
    expect(args.streamsDir).toBe(sourceFolder(activePersona().id, "streams"));
    expect(args.persona).toBe("milky-green");
    expect(parseRefineArgs(["--streams-dir", "a/./b/"]).streamsDir).toBe("a/b");
  });

  test("--persona other than the installed one is a usage error", async () => {
    const io = captureIo();
    expect(await refineMain(["--persona", "someone-else", "--dry-run"], io.io)).toBe(2);
    expect(io.stderr()).toEndWith(
      "laplace-refine: error: argument --persona: write --persona someone-else in full\n",
    );
  });

  test("no transcripts is a warning and exit 0", async () => {
    const io = captureIo();
    expect(await refineMain(["--streams-dir", join(work, "nowhere")], io.io)).toBe(0);
    expect(logs.records).toEqual([
      ["WARNING", "No streams to process. Add files under streams/ or pass paths."],
    ]);
    expect(io.stdout()).toBe("");
  });
});

/** The NDJSON lines, without their timestamps. */
function events(text: string): Record<string, unknown>[] {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => {
      const { t, ...event } = JSON.parse(line) as Record<string, unknown>;
      expect(typeof t).toBe("number");
      return event;
    });
}

describe("--json", () => {
  test("stdout carries only events; the summary goes to stderr", async () => {
    const seen: SeenRequest[] = [];
    const canned = cannedFetch(RESPONSES.run as Canned[], seen);
    const io = captureIo();
    const scenario = golden_.scenarios.find((s) => s.name === "run") as Scenario;
    const code = await refineMain(
      ["--json", "--streams-dir", streams, "--model", "~google/gemini-flash-latest"].concat([
        "--concurrency",
        "1",
      ]),
      { ...io.io, fetch: canned.fetch, now: FIXED_NOW, monotonic: FIXED_CLOCK },
    );
    expect(code).toBe(1);
    expect(io.stderr()).toBe(scenario.stdout);
    const got = events(io.stdout());
    const item = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
      v: 1,
      type: "item",
      stage: "refine",
      item: id,
      video: id.slice(11),
      status,
      ...extra,
    });
    const a = "2026-01-02-BV1aaaaaaaaa";
    expect(got.filter((e) => e.type !== "progress")).toEqual([
      { v: 1, type: "stage", stage: "refine", status: "start", total: 6 },
      item(a, "start", { index: 1, total: 6 }),
      item(a, "done", { index: 1, total: 6, costUsd: expect.any(Number) }),
      item("2026-01-03-BV1bbbbbbbbb_p1", "start", { index: 2, total: 6 }),
      item("2026-01-03-BV1bbbbbbbbb_p1", "failed", {
        index: 2,
        total: 6,
        message: "1 of 1 chunks failed",
        costUsd: 0.0025,
      }),
      item("2026-01-04-BV1ccccccccc", "skipped", { index: 3, total: 6 }),
      { ...item("2026-01-05-BV1ddddddddd", "start", { index: 4, total: 6 }), video: undefined },
      {
        ...item("2026-01-05-BV1ddddddddd", "failed", {
          index: 4,
          total: 6,
          message: "2 of 2 chunks failed",
          costUsd: 0,
        }),
        video: undefined,
      },
      item("2026-01-06-BV1eeeeeeeee", "start", { index: 5, total: 6 }),
      item("2026-01-06-BV1eeeeeeeee", "failed", {
        index: 5,
        total: 6,
        message: "5 of 5 chunks failed",
        costUsd: expect.any(Number),
      }),
      item("2026-01-07-BV1fffffffff", "skipped", { index: 6, total: 6 }),
      { v: 1, type: "stage", stage: "refine", status: "failed" },
      {
        v: 1,
        type: "summary",
        stage: "refine",
        ok: false,
        counts: {
          streams: 6,
          chunksNew: 3,
          chunksSkipped: 2,
          chunksFailed: 8,
          tokensIn: 15050,
          tokensOut: 11769,
        },
        durationSec: 0,
        costUsd: expect.any(Number),
        costSource: "estimated",
        failures: [
          { item: "2026-01-03-BV1bbbbbbbbb_p1", error: "1 of 1 chunks failed" },
          { item: "2026-01-05-BV1ddddddddd", error: "2 of 2 chunks failed" },
          { item: "2026-01-06-BV1eeeeeeeee", error: "5 of 5 chunks failed" },
        ],
      },
    ]);
    expect(got.filter((e) => e.type === "progress" && e.item === a)).toEqual(
      [1, 2, 3].map((done) => ({
        v: 1,
        type: "progress",
        stage: "refine",
        item: a,
        video: "BV1aaaaaaaaa",
        done,
        total: 3,
        unit: "chunks",
      })),
    );
  });

  test("a dry run ends with a summary of the estimate", async () => {
    const io = captureIo();
    expect(
      await refineMain(
        ["--json", "--dry-run", "--streams-dir", streams, "--model", "~google/gemini-flash-latest"],
        { ...io.io, monotonic: FIXED_CLOCK },
      ),
    ).toBe(0);
    const scenario = golden_.scenarios.find((s) => s.name === "dry-run") as Scenario;
    expect(io.stderr()).toBe(scenario.stdout);
    expect(events(io.stdout())).toEqual([
      {
        v: 1,
        type: "summary",
        stage: "refine",
        ok: true,
        counts: {
          streams: 6,
          chunksNew: 12,
          chunksSkipped: 1,
          chunksFailed: 0,
          tokensIn: 20539,
          tokensOut: 16800,
        },
        durationSec: 0,
        costUsd: (20539 * 0.075 + 16800 * 0.3) / 1_000_000,
        costSource: "estimated",
      },
    ]);
  });

  test("a missing API key fails the stage with missing-credential", async () => {
    const restore = setEnv({ OPENROUTER_API_KEY: undefined });
    try {
      const io = captureIo();
      expect(await refineMain(["--json", "--streams-dir", streams], io.io)).toBe(1);
      const message =
        "Refinement needs an API key. Set OPENROUTER_API_KEY (reused from the LLM config) or " +
        "REFINE_API_KEY for a different provider.";
      expect(logs.records).toEqual([["ERROR", message]]);
      expect(events(io.stdout())).toEqual([
        {
          v: 1,
          type: "stage",
          stage: "refine",
          status: "failed",
          code: "missing-credential",
          message,
        },
        {
          v: 1,
          type: "summary",
          stage: "refine",
          ok: false,
          counts: {
            streams: 0,
            chunksNew: 0,
            chunksSkipped: 0,
            chunksFailed: 0,
            tokensIn: 0,
            tokensOut: 0,
          },
          durationSec: 0,
        },
      ]);
    } finally {
      restore();
    }
  });

  test("REFINE_API_KEY wins over OPENROUTER_API_KEY", async () => {
    const restore = setEnv({ REFINE_API_KEY: "refine-key" });
    try {
      const seen: SeenRequest[] = [];
      const canned = cannedFetch([], seen);
      const io = captureIo();
      await refineMain(["--streams-dir", streams, join(streams, "2026-01-05-BV1ddddddddd.md")], {
        ...io.io,
        fetch: canned.fetch,
      });
      expect(seen.map((r) => r.headers.authorization)).toEqual([
        "Bearer refine-key",
        "Bearer refine-key",
      ]);
    } finally {
      restore();
    }
  });

  test("a second run for the persona exits 1, with code locked", async () => {
    const release = acquireLock(sourcesLockKey("milky-green"), "laplace-refine");
    try {
      const io = captureIo();
      expect(await refineMain(["--json", "--streams-dir", streams], io.io)).toBe(1);
      const message = `Another laplace-refine is running for milky-green (pid ${process.pid}).`;
      expect(logs.records).toEqual([["ERROR", message]]);
      expect(events(io.stdout())[0]).toEqual({
        v: 1,
        type: "stage",
        stage: "refine",
        status: "failed",
        code: "locked",
        message,
      });
      // A dry run writes nothing, so it doesn't wait for the lock.
      expect(await refineMain(["--dry-run", "--streams-dir", streams], captureIo().io)).toBe(0);
    } finally {
      release();
    }
  });
});

describe("cancellation", () => {
  test("Ctrl-C stops the run, saves what finished and ends with a cancelled summary", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fake = async (_input: unknown, init?: RequestInit): Promise<Response> => {
      calls++;
      const user = (JSON.parse(init?.body as string) as { messages: { content: string }[] })
        .messages[1]?.content as string;
      if (calls === 3) {
        // The third request, chunk 001's pass 1, is still in flight when Ctrl-C comes.
        setTimeout(() => controller.abort(new DOMException("Interrupted by SIGINT", "AbortError")));
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          }),
        );
      }
      const content = user.includes("Structured extract:")
        ? JSON.stringify({ heading: "标题", summary: "摘要。", details: "细节。" })
        : JSON.stringify({ topics: ["t"] });
      return completion({
        status: 200,
        content,
        finish_reason: "stop",
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 },
      });
    };
    const io = captureIo();
    const code = await refineMain(
      ["--json", "--concurrency", "1", join(streams, "2026-01-02-BV1aaaaaaaaa.md")],
      {
        ...io.io,
        fetch: fake as unknown as typeof fetch,
        signal: controller.signal,
        now: FIXED_NOW,
        monotonic: FIXED_CLOCK,
      },
    );
    expect(code).toBe(1);
    expect(calls).toBe(3);
    const got = events(io.stdout());
    expect(got.at(-2)).toEqual({ v: 1, type: "stage", stage: "refine", status: "cancelled" });
    expect(got.at(-1)).toMatchObject({ type: "summary", ok: false, cancelled: true });
    expect(got.find((e) => e.status === "cancelled" && e.type === "item")).toMatchObject({
      item: "2026-01-02-BV1aaaaaaaaa",
      code: "cancelled",
    });
    const saved = JSON.parse(
      readFileSync(join(streams, "2026-01-02-BV1aaaaaaaaa.refined.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual([
      "schema_version",
      "stream_id",
      "chunks",
      "model",
      "refined_at",
    ]);
    expect(Object.keys(saved.chunks as object)).toEqual(["2026-01-02-BV1aaaaaaaaa::000"]);
  });
});

test("the runs above worked on copies: the fixture transcripts have no new sidecar", () => {
  expect(sortedPy(readdirSync(STREAMS).filter((name) => name.endsWith(".refined.json")))).toEqual([
    "2026-01-03-BV1bbbbbbbbb_p1.refined.json",
    "2026-01-04-BV1ccccccccc.refined.json",
  ]);
});
