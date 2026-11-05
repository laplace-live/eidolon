// fixtures/transcribe/parser.golden.json is Python's argparse running the port's parser (its
// `printed_by` says how); the runs are served packages/ingest's run.golden.json jobs, which Python's
// transcribe.py was served.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, PROJECT_ROOT, sourceFolder } from "@eidolon/config";
import { acquireLock, sourcesLockKey, transcribe } from "@eidolon/ingest";
import {
  type FakeJob,
  fakeBinaries,
  fakeSoniox,
  type Override,
} from "../../../packages/ingest/test/fake_soniox.ts";
import { ArgparseExit, parseArgs } from "../src/argparse.ts";
import { TRANSCRIBE_PARSER, transcribeMain } from "../src/transcribe.ts";
import { blockNetwork, captureIo, captureLogs, setEnv } from "./helpers.ts";

blockNetwork();

const FIX = join(import.meta.dir, "fixtures/transcribe");
const INGEST_FIX = join(PROJECT_ROOT, "packages/ingest/test/fixtures/transcribe");

interface ParseCase {
  argv: string[];
  code: number | "parsed";
  stdout?: string;
  stderr?: string;
  ns?: Record<string, unknown>;
}

const parserGolden = (await Bun.file(join(FIX, "parser.golden.json")).json()) as {
  transcribe: ParseCase[];
  close_matches: [string, string[], string[]][];
};
const runGolden = (await Bun.file(join(INGEST_FIX, "run.golden.json")).json()) as {
  scenarios: {
    name: string;
    audio: string;
    date: string;
    jobs: FakeJob[];
    md: string;
    payload: string;
  }[];
};
const single = runGolden.scenarios.find(
  (s) => s.name === "single",
) as (typeof runGolden.scenarios)[0];

let work = "";
let logs!: ReturnType<typeof captureLogs>;
let restoreEnv: () => void = () => {};
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "cli-transcribe-"));
  logs = captureLogs();
  restoreEnv = setEnv({ SONIOX_API_KEY: "test-key", SONIOX_ASYNC_MODEL: undefined });
});
afterEach(() => {
  restoreEnv();
  logs.stop();
  rmSync(work, { recursive: true, force: true });
});

test("the parser is argparse's, help and errors included", () => {
  for (const c of parserGolden.transcribe) {
    let got: ParseCase;
    try {
      got = { argv: c.argv, code: "parsed", ns: parseArgs(TRANSCRIBE_PARSER, c.argv) };
    } catch (error) {
      if (!(error instanceof ArgparseExit)) throw error;
      got = { argv: c.argv, code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
    expect(got).toEqual(c);
  }
});

test("a missing audio file's near misses are difflib's", () => {
  for (const [word, names, expected] of parserGolden.close_matches) {
    expect(transcribe.closeMatches(word, names, 5, 0.5)).toEqual(expected);
  }
});

function setup(durationSec = 3_725.5) {
  const audio = join(work, single.audio);
  writeFileSync(audio, Buffer.alloc(2048));
  const outDir = join(work, "streams");
  return { audio, outDir, ...fakeBinaries(work, durationSec) };
}

async function run(
  argv: string[],
  jobs: FakeJob[] = single.jobs,
  override?: Override,
  signal?: AbortSignal,
) {
  const { ffprobe, ffmpeg } = fakeBinaries(work, 3_725.5);
  const soniox = fakeSoniox(jobs, override);
  const io = captureIo();
  const code = await transcribeMain(argv, {
    ...io.io,
    fetch: soniox.fetch,
    sleep: async () => {},
    ffprobe,
    ffmpeg,
    today: () => "2026-11-05",
    signal,
  });
  const events = io
    .stdout()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { code, io, soniox, events };
}

const shape = (events: Record<string, unknown>[]) =>
  events.map((e) => [e.type, e.type === "summary" ? e.ok : (e.status ?? null)]);

describe("a run", () => {
  test("writes Python's transcript and payload, and reports NDJSON under --json", async () => {
    const { audio, outDir } = setup();
    const contextFile = join(INGEST_FIX, "glossary/full.toml");
    const argv = [audio, "--date", single.date, "--out-dir", outDir, "--context-file", contextFile];
    const { code, events, io } = await run([...argv, "--json"]);
    expect(code).toBe(0);
    const stem = `${single.date}-BV1aaaaaaaaa`;
    expect(readFileSync(join(outDir, `${stem}.md`), "utf8")).toBe(single.md);
    expect(readFileSync(join(outDir, `${stem}.soniox.json`), "utf8")).toBe(single.payload);
    expect(io.stderr()).toBe("");
    expect(shape(events)).toEqual([
      ["stage", "start"],
      ["item", "start"],
      ["item", "done"],
      ["stage", "done"],
      ["summary", true],
    ]);
    expect(events.every((e) => e.v === 1 && typeof e.t === "number")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      stage: "transcribe",
      counts: { total: 1, skipped: 0, skippedNoDate: 0, succeeded: 1, failed: 0, noSpeech: 0 },
      costSource: "estimated",
      costUsd: expect.closeTo((3_725.4 / 3600) * 0.1, 10),
    });
    expect(logs.records.at(-1)).toEqual([
      "INFO",
      "Next: hand-edit the H2 headings to be more descriptive, then run:\n" +
        "    bun run laplace-ingest-streams --persona milky-green",
    ]);
  });

  test("defaults: today's date, the persona's streams folder and glossary, the setting's model", async () => {
    const { audio } = setup();
    const restore = setEnv({ SONIOX_ASYNC_MODEL: "stt-async-v6" });
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run([audio, "--language", ""]);
    } finally {
      restore();
    }
    expect(result.code).toBe(0);
    const streams = sourceFolder("milky-green", "streams");
    expect(existsSync(join(streams, "2026-11-05-BV1aaaaaaaaa.md"))).toBe(true);
    const glossary = join(PROJECT_ROOT, "personas/milky-green/glossary.toml");
    expect(logs.records).toContainEqual([
      "INFO",
      `Soniox context: 6 general, 191 chars text, 122 terms (from ${glossary})`,
    ]);
    const body = JSON.parse(result.soniox.requests[1]?.json as string);
    expect(body).toMatchObject({ model: "stt-async-v6", context: { terms: expect.any(Array) } });
    expect(body.language_hints).toBeUndefined();
    rmSync(join(dataHome(), "sources"), { recursive: true, force: true });
  });

  test("--no-context sends none", async () => {
    const { audio, outDir } = setup();
    const { code, soniox } = await run([audio, "--out-dir", outDir, "--no-context"]);
    expect(code).toBe(0);
    expect(JSON.parse(soniox.requests[1]?.json as string).context).toBeUndefined();
  });
});

describe("what is already transcribed", () => {
  test("a transcript is not overwritten without --force", async () => {
    const { audio, outDir } = setup();
    mkdirSync(outDir);
    const md = join(outDir, "2026-11-05-BV1aaaaaaaaa.md");
    writeFileSync(md, "old");
    const { code, soniox, events } = await run([audio, "--out-dir", outDir, "--json"]);
    expect(code).toBe(1);
    expect(soniox.requests).toEqual([]);
    expect(readFileSync(md, "utf8")).toBe("old");
    expect(logs.records).toEqual([
      ["ERROR", `${md} already exists; pass --force to transcribe it again (Soniox bills again).`],
    ]);
    expect(shape(events)).toEqual([
      ["stage", "start"],
      ["item", "skipped"],
      ["stage", "done"],
      ["summary", false],
    ]);
    expect(events.at(-1)).toMatchObject({ counts: { skipped: 1 } });
  });

  test("--force transcribes again, warning that the refinements are stale", async () => {
    const { audio, outDir } = setup();
    mkdirSync(outDir);
    writeFileSync(join(outDir, "2026-11-05-BV1aaaaaaaaa.md"), "old");
    writeFileSync(join(outDir, "2026-11-05-BV1aaaaaaaaa.refined.json"), "{}");
    const { code } = await run([audio, "--out-dir", outDir, "--force", "--no-context"]);
    expect(code).toBe(0);
    expect(logs.records).toContainEqual([
      "WARNING",
      `${join(outDir, "2026-11-05-BV1aaaaaaaaa.refined.json")} refines the transcript being ` +
        "replaced; run laplace-refine --force after this.",
    ]);
  });

  test("audio Soniox found no speech in is done: it is billed once", async () => {
    const { audio, outDir } = setup();
    const silent = { ...single.jobs[0], transcript: { id: "x", text: "", tokens: [] } } as FakeJob;
    expect(
      (await run([audio, "--out-dir", outDir, "--json"], [silent])).events.at(-1),
    ).toMatchObject({
      ok: true,
      counts: { noSpeech: 1, succeeded: 0 },
    });
    expect(existsSync(join(outDir, "2026-11-05-BV1aaaaaaaaa.md"))).toBe(false);
    const again = await run([audio, "--out-dir", outDir, "--json"]);
    expect(again.code).toBe(1);
    expect(again.soniox.requests).toEqual([]);
    expect(again.events[1]).toMatchObject({ status: "skipped", code: "no-speech" });
  });
});

describe("failing before Soniox", () => {
  test("a missing audio file names its near misses in the same folder", async () => {
    for (const name of ["BV1aaaaaaaaa!!.m4a", "BV1aaaaaaaaa_1.m4a", "unrelated.txt"]) {
      writeFileSync(join(work, name), "");
    }
    const missing = join(work, "BV1aaaaaaaaa.m4a");
    const { code, events } = await run([missing, "--json"]);
    expect(code).toBe(1);
    expect(logs.records).toEqual([
      ["ERROR", `Audio file not found: ${missing}`],
      ["ERROR", "Did you mean one of these (in the same directory)?"],
      ["ERROR", `  ${join(work, "BV1aaaaaaaaa_1.m4a")}`],
      ["ERROR", `  ${join(work, "BV1aaaaaaaaa!!.m4a")}`],
    ]);
    expect(events.at(-1)).toMatchObject({ ok: false, counts: { failed: 1 } });
    logs.records.length = 0;
    expect((await run([join(work, "gone/a.m4a")])).code).toBe(1);
    expect(logs.records.at(-1)).toEqual([
      "ERROR",
      `Parent directory also missing: ${join(work, "gone")}`,
    ]);
  });

  test("without SONIOX_API_KEY", async () => {
    const { audio, outDir } = setup();
    const restore = setEnv({ SONIOX_API_KEY: "" });
    try {
      const { code, events, soniox } = await run([audio, "--out-dir", outDir, "--json"]);
      expect(code).toBe(1);
      expect(soniox.requests).toEqual([]);
      expect(events.find((e) => e.type === "stage" && e.status === "failed")).toMatchObject({
        code: "missing-credential",
      });
    } finally {
      restore();
    }
  });

  test("while another run holds the persona's sources", async () => {
    const { audio, outDir } = setup();
    const release = acquireLock(sourcesLockKey("milky-green"), "pipeline");
    try {
      const { code, events } = await run([audio, "--out-dir", outDir, "--json"]);
      expect(code).toBe(1);
      expect(logs.records).toEqual([
        ["ERROR", `Another pipeline is running for milky-green (pid ${process.pid}).`],
      ]);
      expect(events.find((e) => e.type === "stage" && e.status === "failed")).toMatchObject({
        code: "locked",
      });
    } finally {
      release();
    }
  });

  test("a Soniox failure is logged, not a traceback", async () => {
    const { audio, outDir } = setup();
    const { code, events } = await run(
      [audio, "--out-dir", outDir, "--no-context", "--json"],
      single.jobs,
      (r) =>
        r.path === "/transcriptions"
          ? Response.json({ message: "no money" }, { status: 402 })
          : undefined,
    );
    expect(code).toBe(1);
    expect(logs.records).toContainEqual(["ERROR", "no money (HTTP 402)"]);
    expect(events.at(-1)).toMatchObject({
      ok: false,
      failures: [{ item: "BV1aaaaaaaaa.m4a", error: "no money (HTTP 402)" }],
    });
  });
});

test("a cancelled run deletes its Soniox job and ends with a cancelled summary", async () => {
  const { audio, outDir } = setup();
  const controller = new AbortController();
  const { code, events, soniox } = await run(
    [audio, "--out-dir", outDir, "--no-context", "--json"],
    single.jobs,
    (r) => {
      if (r.method !== "GET") return undefined;
      controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
      return "hang";
    },
    controller.signal,
  );
  expect(code).toBe(1);
  expect(soniox.requests.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([
    "/transcriptions/00000000-0000-4000-8000-000000000001",
    "/files/file-1",
  ]);
  expect(shape(events)).toEqual([
    ["stage", "start"],
    ["item", "start"],
    ["item", "cancelled"],
    ["stage", "cancelled"],
    ["summary", false],
  ]);
  expect(events.at(-1)).toMatchObject({ cancelled: true });
});
