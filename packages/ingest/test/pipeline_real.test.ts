// A dry run over the real sources under <EIDOLON_REAL_HOME>/sources/milky-green, read only, against
// what tools/pipeline.py's dry run makes of them (contract §7 item 7). Python's side comes from
// fixtures/pipeline/real.py, run at test time through `uv run --offline --no-sync`; its output is
// never committed. Skips when the data or uv is absent, unless EIDOLON_REQUIRE_PARITY=1.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "../src/index.ts";
import { captureLogs } from "./pipeline_helpers.ts";

const REAL = process.env.EIDOLON_REAL_HOME ?? "";
const SOURCES = join(REAL, "sources/milky-green");
const VODS = join(SOURCES, "vods");
const STREAMS = join(SOURCES, "streams");
const LISTS = join(SOURCES, "lists");
const INDEX = join(REAL, "personas/milky-green/index");
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const REPO = join(import.meta.dir, "../../..");
const SCRIPT = join(import.meta.dir, "fixtures/pipeline/real.py");
const UV = Bun.which("uv");
const HAVE_DATA = [VODS, STREAMS, LISTS, INDEX].every(existsSync);
const MODEL = "~google/gemini-pro-latest";

interface PythonDryRun {
  readonly transcribe: {
    readonly logs: [string, string][];
    readonly counts: { total: number; skipped: number; skipped_no_date: number };
    readonly jobs: string[];
  };
  readonly refine: { readonly text: string };
}

async function python(): Promise<PythonDryRun> {
  const proc = Bun.spawn(
    [UV as string, "run", "--offline", "--no-sync", "python", SCRIPT, VODS, STREAMS, MODEL],
    { cwd: REPO, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, err).toBe(0);
  return JSON.parse(out) as PythonDryRun;
}

/** "Estimated total: N chunks" from the dry run's text. */
function estimatedChunks(text: string): number {
  const match = /^Estimated total: (\d+) chunks/m.exec(text);
  expect(match, text).not.toBeNull();
  return Number(match?.[1]);
}

test.skipIf((!HAVE_DATA || UV === null) && !REQUIRED)(
  "a dry run over the real sources plans what Python's does: the one audio file left to transcribe, and the refine work",
  async () => {
    expect(HAVE_DATA, `no real sources or index under ${REAL}`).toBe(true);
    expect(UV, "uv is not on PATH").not.toBeNull();
    const fromPython = await python();

    // The human dry run: Python's text, stage by stage.
    const logs = captureLogs();
    const printed: string[] = [];
    let report: pipeline.PipelineReport;
    try {
      report = await pipeline.runPipeline({
        stages: ["transcribe", "refine"],
        urlList: null,
        urls: [],
        vodsDir: VODS,
        streamsDir: STREAMS,
        dbPath: INDEX,
        dryRun: true,
        refineModel: MODEL,
        contextFile: null,
        print: (text) => printed.push(text),
      });
    } finally {
      logs.stop();
    }
    const planned = logs.records.filter(([, message]) => /^\[\d+\/\d+\] /.test(message));
    expect(planned).toEqual(fromPython.transcribe.logs as [never, string][]);
    const t = report.transcribe as pipeline.TranscribeStageReport;
    const counts = fromPython.transcribe.counts;
    expect([t.total, t.skipped, t.skippedNoDate, t.failed.length]).toEqual([
      counts.total,
      counts.skipped,
      counts.skipped_no_date,
      0,
    ]);
    expect(printed.join("")).toBe(fromPython.refine.text);
    expect(report.ok).toBe(true);

    // The plan --dry-run --json emits: the same audio files left to transcribe, the same chunks
    // left to refine.
    const plan = await pipeline.planPipeline("milky-green", {
      vodsDir: VODS,
      streamsDir: STREAMS,
      listsDir: LISTS,
      dbPath: INDEX,
      transcribeModel: "stt-async-v5",
      refineModel: MODEL,
    });
    const downloaded = plan.videos.filter((video) => video.download === "done");
    expect(downloaded).toHaveLength(counts.total);
    const by = (state: string) => downloaded.filter((video) => video.transcribe === state);
    expect(by("pending").map((video) => `${video.id}.m4a`)).toEqual(fromPython.transcribe.jobs);
    expect(by("done")).toHaveLength(counts.skipped);
    expect(by("no-date")).toHaveLength(counts.skipped_no_date);
    const transcribed = plan.videos.filter((video) => video.refine !== null);
    expect(transcribed).toHaveLength(estimatedLines(fromPython.refine.text));
    const toRefine = transcribed.reduce(
      (sum, video) => sum + (video.refine ? video.refine.chunks - video.refine.done : 0),
      0,
    );
    expect(toRefine).toBe(estimatedChunks(fromPython.refine.text));

    // Python's index has no build record, so `indexed` is the catalog's word.
    const catalog = JSON.parse(readFileSync(join(INDEX, "stream_catalog.json"), "utf8")) as {
      broadcasts: { stream_ids: string[] }[];
    };
    const catalogued = new Set(catalog.broadcasts.flatMap((broadcast) => broadcast.stream_ids));
    for (const video of transcribed) {
      const id = `${video.uploadDate}-${video.id}`;
      expect([id, video.indexed]).toEqual([id, catalogued.has(id)]);
    }
  },
  600_000,
);

/** The transcripts the dry run's text lists, one line each. */
function estimatedLines(text: string): number {
  return text.split("\n").filter((line) => /^ {2}\S.*\.md: /.test(line)).length;
}
