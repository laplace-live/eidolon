// A dry run over the real sources under <EIDOLON_REAL_HOME>/sources/milky-green, read only: the
// human dry run and the plan `--dry-run --json` emits must agree on every audio file and every
// chunk left to refine. Skips when the data is absent, unless EIDOLON_REQUIRE_PARITY=1.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { iterStreams, pipeline, refine } from "../src/index.ts";
import { captureLogs } from "./pipeline_helpers.ts";

const REAL = process.env.EIDOLON_REAL_HOME ?? "";
const SOURCES = join(REAL, "sources/milky-green");
const VODS = join(SOURCES, "vods");
const STREAMS = join(SOURCES, "streams");
const LISTS = join(SOURCES, "lists");
const INDEX = join(REAL, "personas/milky-green/index");
const REQUIRED = process.env.EIDOLON_REQUIRE_PARITY === "1";
const HAVE_DATA = [VODS, STREAMS, LISTS, INDEX].every(existsSync);
const MODEL = "~google/gemini-pro-latest";

type TranscribeState = "pending" | "done" | "no-speech" | "no-date";

/** The `[i/n]` line the dry run logs for each audio file, as its file's stem and state. */
const PLANNED: readonly [RegExp, TranscribeState][] = [
  [/^\[\d+\/\d+\] \[dry-run\] would transcribe (.+) \(date=/, "pending"],
  [/^\[\d+\/\d+\] (.+): already transcribed, no speech → /, "no-speech"],
  [/^\[\d+\/\d+\] (.+): already transcribed → /, "done"],
  [/^\[\d+\/\d+\] (.+): no upload_date in /, "no-date"],
];

function plannedState(message: string): [string, TranscribeState | null] {
  for (const [pattern, state] of PLANNED) {
    const name = pattern.exec(message)?.[1];
    if (name !== undefined) return [name.replace(/\.[^.]*$/, ""), state];
  }
  return [message, null];
}

/** "Estimated total: N chunks" from the dry run's text. */
function estimatedChunks(text: string): number {
  const match = /^Estimated total: (\d+) chunks/m.exec(text);
  expect(match, text).not.toBeNull();
  return Number(match?.[1]);
}

test.skipIf(!HAVE_DATA && !REQUIRED)(
  "a dry run over the real sources plans what it prints: the audio files left to transcribe, and the refine work",
  async () => {
    expect(HAVE_DATA, `no real sources or index under ${REAL}`).toBe(true);

    // The human dry run, stage by stage.
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
    expect(report.ok).toBe(true);
    const t = report.transcribe as pipeline.TranscribeStageReport;
    expect(t.failed).toEqual([]);
    const planned = logs.records
      .map(([, message]) => message)
      .filter((message) => /^\[\d+\/\d+\] /.test(message));
    expect(planned.map((message) => message.slice(0, message.indexOf("]") + 1))).toEqual(
      Array.from({ length: t.total }, (_, i) => `[${i + 1}/${t.total}]`),
    );
    const states = planned.map(plannedState);
    expect(states.filter(([, state]) => state === null)).toEqual([]);
    const logged = (state: TranscribeState) =>
      states.filter(([, s]) => s === state).map(([stem]) => stem);
    expect(logged("done").length + logged("no-speech").length).toBe(t.skipped);
    expect(logged("no-date")).toHaveLength(t.skippedNoDate);

    // The refine stage prints refine's own dry run over every transcript.
    const text = printed.join("");
    expect(text).toBe((await refine.dryRun(iterStreams(STREAMS), MODEL)).text);

    // The plan --dry-run --json emits: the same audio files in each state, the same chunks left
    // to refine.
    const plan = await pipeline.planPipeline("milky-green", {
      vodsDir: VODS,
      streamsDir: STREAMS,
      listsDir: LISTS,
      dbPath: INDEX,
      transcribeModel: "stt-async-v5",
      refineModel: MODEL,
    });
    const downloaded = plan.videos.filter((video) => video.download === "done");
    expect(downloaded).toHaveLength(t.total);
    for (const state of ["pending", "done", "no-speech", "no-date"] as const) {
      const ids = downloaded.filter((video) => video.transcribe === state).map((video) => video.id);
      expect([state, ids.sort()]).toEqual([state, logged(state).sort()]);
    }
    const transcribed = plan.videos.filter((video) => video.refine !== null);
    expect(transcribed).toHaveLength(estimatedLines(text));
    const toRefine = transcribed.reduce(
      (sum, video) => sum + (video.refine ? video.refine.chunks - video.refine.done : 0),
      0,
    );
    expect(toRefine).toBe(estimatedChunks(text));

    // `indexed` reads the index's build record when it has one, else the catalog's stream ids.
    const recordPath = join(INDEX, "stream_chunks.meta.json");
    if (existsSync(recordPath)) {
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
        sources: { name: string }[];
      };
      const listed = new Set(record.sources.map((source) => source.name));
      for (const video of transcribed) {
        const name = `${video.uploadDate}-${video.id}.md`;
        if (video.indexed) expect([name, listed.has(name)]).toEqual([name, true]);
      }
      expect(transcribed.some((video) => video.indexed)).toBe(true);
    } else {
      const catalog = JSON.parse(readFileSync(join(INDEX, "stream_catalog.json"), "utf8")) as {
        broadcasts: { stream_ids: string[] }[];
      };
      const catalogued = new Set(catalog.broadcasts.flatMap((broadcast) => broadcast.stream_ids));
      for (const video of transcribed) {
        const id = `${video.uploadDate}-${video.id}`;
        expect([id, video.indexed]).toEqual([id, catalogued.has(id)]);
      }
    }
  },
  600_000,
);

/** The transcripts the dry run's text lists, one line each. */
function estimatedLines(text: string): number {
  return text.split("\n").filter((line) => /^ {2}\S.*\.md: /.test(line)).length;
}
