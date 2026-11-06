// POST jobs' typed requests: the exact argv each command and option set spawns, what the real
// CLI parsers read from it, and the requests refused before anything runs.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "@eidolon/cli";
import { CLI_ENTRY, jobArgv } from "@eidolon/cli/job";
import { dataHome } from "@eidolon/config";
import { BUILD_STREAM_CATALOG_PARSER } from "../../../cli/src/build_stream_catalog.ts";
import { DOWNLOAD_PARSER } from "../../../cli/src/download.ts";
import { INGEST_FACTS_PARSER } from "../../../cli/src/ingest_facts.ts";
import { ingestStreamsParser } from "../../../cli/src/ingest_streams.ts";
import { PIPELINE_PARSER, parsePipelineArgs } from "../../../cli/src/pipeline.ts";
import { refineParser } from "../../../cli/src/refine.ts";
import { TRANSCRIBE_PARSER } from "../../../cli/src/transcribe.ts";
import type { JobRequest } from "../../src/local/api.ts";
import { JobRefused, type JobSpec, parseJobRequest } from "../../src/local/jobs/argv.ts";
import { BATCH, seedSources, VIDEO } from "./jobs-harness.ts";

let batch: string;
let audio: string;

beforeAll(() => {
  ({ batch, audio } = seedSources());
  mkdirSync(join(dataHome(), "personas", "alice"), { recursive: true });
});

afterAll(() => {
  rmSync(dataHome(), { recursive: true, force: true });
});

const PERSONA = ["--persona", "milky-green"];
const URL = "https://space.bilibili.com/1/lists/2?type=series";

function argv(spec: JobSpec): string[] {
  return jobArgv(spec.cli, spec.args);
}

describe("each command spawns a fixed argv", () => {
  const cases: [string, unknown, string[], Record<string, unknown>][] = [
    [
      "pipeline, defaults",
      { command: "pipeline", persona: "milky-green", options: { batch: BATCH } },
      ["pipeline", ...PERSONA, "--", "<batch>"],
      { batch: BATCH },
    ],
    [
      "pipeline, every option",
      {
        command: "pipeline",
        persona: "milky-green",
        options: {
          batch: BATCH,
          stages: ["refine", "download"],
          abortOnError: true,
          transcribeConcurrency: 4,
        },
      },
      [
        "pipeline",
        ...PERSONA,
        "--stages",
        "download,refine",
        "--abort-on-error",
        "--transcribe-concurrency",
        "4",
        "--",
        "<batch>",
      ],
      {
        batch: BATCH,
        stages: ["download", "refine"],
        abortOnError: true,
        transcribeConcurrency: 4,
      },
    ],
    [
      "pipeline, the free download alone",
      {
        command: "pipeline",
        persona: "milky-green",
        options: { batch: BATCH, stages: ["download"], abortOnError: false },
      },
      ["pipeline", ...PERSONA, "--stages", "download", "--", "<batch>"],
      { batch: BATCH, stages: ["download"], abortOnError: false },
    ],
    [
      "pipeline, the later stages over every video, no batch",
      {
        command: "pipeline",
        persona: "milky-green",
        options: { stages: ["ingest", "transcribe", "refine"], transcribeConcurrency: 4 },
      },
      [
        "pipeline",
        ...PERSONA,
        "--stages",
        "transcribe,refine,ingest",
        "--transcribe-concurrency",
        "4",
      ],
      { stages: ["transcribe", "refine", "ingest"], transcribeConcurrency: 4 },
    ],
    [
      "download",
      { command: "download", persona: "milky-green", options: { batch: BATCH } },
      ["download", ...PERSONA, "--", "<batch>"],
      { batch: BATCH },
    ],
    [
      "expand",
      { command: "expand", persona: "milky-green", options: { url: URL } },
      ["download", ...PERSONA, "--expand", URL],
      { url: URL },
    ],
    [
      "transcribe",
      {
        command: "transcribe",
        persona: "milky-green",
        options: { video: VIDEO, date: "2024-02-29" },
      },
      ["transcribe", ...PERSONA, "--date", "2024-02-29", "--auto-slice", "--", "<audio>"],
      { video: VIDEO, date: "2024-02-29" },
    ],
    ["refine", { command: "refine", persona: "milky-green" }, ["refine", ...PERSONA], {}],
    [
      "ingest-streams",
      { command: "ingest-streams", persona: "milky-green", options: {} },
      ["ingest-streams", ...PERSONA],
      {},
    ],
    [
      "ingest-facts",
      { command: "ingest-facts", persona: "alice" },
      ["ingest-facts", "--persona", "alice"],
      {},
    ],
    [
      "build-stream-catalog",
      { command: "build-stream-catalog", persona: "milky-green", options: null },
      ["build-stream-catalog", ...PERSONA],
      {},
    ],
    [
      "plan",
      { command: "plan", persona: "milky-green" },
      ["pipeline", ...PERSONA, "--dry-run"],
      {},
    ],
    [
      "plan, refreshed",
      { command: "plan", persona: "milky-green", options: { refresh: true } },
      ["pipeline", ...PERSONA, "--dry-run"],
      { refresh: true },
    ],
  ];

  for (const [label, body, golden, options] of cases) {
    test(label, () => {
      const spec = parseJobRequest(body);
      const expected = golden.map((arg) =>
        arg === "<batch>" ? batch : arg === "<audio>" ? audio : arg,
      );
      const [cli, ...args] = expected as [string, ...string[]];
      expect(argv(spec)).toEqual([
        process.execPath,
        "--no-env-file",
        CLI_ENTRY,
        cli,
        "--json",
        ...args,
      ]);
      expect(spec.options).toEqual(options);
      expect(spec.persona).toBe((body as { persona: string }).persona);
    });
  }
});

describe("the CLI reads each argv as meant", () => {
  const read = (spec: JobSpec) => ["--json", ...spec.args];

  test("pipeline: the batch, the stages and flags, and nothing it wasn't sent", () => {
    const spec = parseJobRequest({
      command: "pipeline",
      persona: "milky-green",
      options: {
        batch: BATCH,
        stages: ["transcribe", "ingest"],
        abortOnError: true,
        transcribeConcurrency: 4,
      },
    });
    expect(parseArgs(PIPELINE_PARSER, read(spec))).toMatchObject({
      url_list: batch,
      stages: ["transcribe", "ingest"],
      abort_on_error: true,
      transcribe_concurrency: 4,
      persona: "milky-green",
      json: true,
      dry_run: false,
      yt_dlp_args: "",
      cookies: null,
      cookies_from_browser: null,
      vods_dir: null,
      streams_dir: null,
      db_path: null,
      refine_force: false,
    });
  });

  test("pipeline without a batch: the later stages, which the CLI runs without a list", () => {
    const spec = parseJobRequest({
      command: "pipeline",
      persona: "milky-green",
      options: { stages: ["transcribe", "refine"] },
    });
    const args = read(spec);
    expect(parseArgs(PIPELINE_PARSER, args)).toMatchObject({
      url_list: null,
      dry_run: false,
      stages: ["transcribe", "refine"],
    });
    expect(parsePipelineArgs(args)).toMatchObject({ urlList: null, persona: "milky-green" });
  });

  test("plan: a dry run of every known video", () => {
    const spec = parseJobRequest({ command: "plan", persona: "milky-green" });
    expect(parseArgs(PIPELINE_PARSER, read(spec))).toMatchObject({
      url_list: null,
      dry_run: true,
      stages: ["download", "transcribe", "refine", "ingest"],
    });
  });

  test("download and expand", () => {
    const download = parseJobRequest({
      command: "download",
      persona: "milky-green",
      options: { batch: BATCH },
    });
    expect(parseArgs(DOWNLOAD_PARSER, read(download))).toMatchObject({
      url_list: batch,
      expand: null,
      yt_dlp_args: "",
    });
    const expand = parseJobRequest({
      command: "expand",
      persona: "milky-green",
      options: { url: URL },
    });
    expect(parseArgs(DOWNLOAD_PARSER, read(expand))).toMatchObject({
      url_list: null,
      expand: URL,
      cookies: null,
    });
  });

  test("transcribe: the audio, the date and slicing, never --force", () => {
    const spec = parseJobRequest({
      command: "transcribe",
      persona: "milky-green",
      options: { video: VIDEO, date: "2024-02-29" },
    });
    expect(parseArgs(TRANSCRIBE_PARSER, read(spec))).toMatchObject({
      audio,
      date: "2024-02-29",
      auto_slice: true,
      force: false,
      out_dir: null,
    });
  });

  test("the commands without options take only the persona", () => {
    for (const [command, parser] of [
      ["refine", refineParser()],
      ["ingest-streams", ingestStreamsParser()],
      ["ingest-facts", INGEST_FACTS_PARSER],
      ["build-stream-catalog", BUILD_STREAM_CATALOG_PARSER],
    ] as const) {
      const spec = parseJobRequest({ command, persona: "milky-green" });
      expect([command, parseArgs(parser, read(spec))]).toMatchObject([
        command,
        { persona: "milky-green", json: true },
      ]);
    }
  });
});

describe("refused requests", () => {
  function refused(body: unknown): JobRefused {
    try {
      parseJobRequest(body);
    } catch (error) {
      if (error instanceof JobRefused) return error;
      throw error;
    }
    throw new Error(`accepted ${JSON.stringify(body)}`);
  }

  const pipeline = (options: Record<string, unknown>) => ({
    command: "pipeline",
    persona: "milky-green",
    options: { batch: BATCH, ...options },
  });

  const cases: [string, unknown, number, string][] = [
    [
      "an args array",
      pipeline({ args: ["--yt-dlp-args", "--exec touch x"] }),
      400,
      "invalid-option",
    ],
    ["a flag of the CLI's", pipeline({ ytDlpArgs: "--exec touch x" }), 400, "invalid-option"],
    ["a path flag", pipeline({ vodsDir: "/tmp" }), 400, "invalid-option"],
    [
      "args at the top",
      { command: "refine", persona: "milky-green", args: ["--clear-cache"] },
      400,
      "bad-request",
    ],
    ["a persona of ../x", { command: "refine", persona: "../x" }, 400, "invalid-persona-id"],
    [
      "a persona that isn't a slug",
      { command: "refine", persona: "Milky Green" },
      400,
      "invalid-persona-id",
    ],
    ["no persona", { command: "refine" }, 400, "invalid-persona-id"],
    ["an unknown persona", { command: "refine", persona: "nobody" }, 400, "unknown-persona"],
    [
      "generate-image",
      { command: "generate-image", persona: "milky-green" },
      400,
      "unknown-command",
    ],
    ["prepare-batch", { command: "prepare-batch", persona: "milky-green" }, 400, "unknown-command"],
    ["no command", { persona: "milky-green" }, 400, "unknown-command"],
    ["a body that isn't an object", ["refine"], 400, "bad-request"],
    [
      "options that aren't an object",
      { command: "refine", persona: "milky-green", options: ["--force"] },
      400,
      "invalid-option",
    ],
    [
      "an option a command doesn't take",
      { command: "refine", persona: "milky-green", options: { force: true } },
      400,
      "invalid-option",
    ],
    [
      "a URL like --exec=…",
      { command: "expand", persona: "milky-green", options: { url: "--exec=touch x" } },
      400,
      "invalid-option",
    ],
    [
      "a file: URL",
      { command: "expand", persona: "milky-green", options: { url: "file:///etc/passwd" } },
      400,
      "invalid-url",
    ],
    [
      "a URL with a space",
      { command: "expand", persona: "milky-green", options: { url: "https://a.example/x y" } },
      400,
      "invalid-url",
    ],
    [
      "a URL with a newline",
      { command: "expand", persona: "milky-green", options: { url: "https://a.example/\nx" } },
      400,
      "invalid-url",
    ],
    [
      "a URL with a NUL",
      { command: "expand", persona: "milky-green", options: { url: "https://a.example/\u0000" } },
      400,
      "invalid-url",
    ],
    [
      "a URL too long",
      {
        command: "expand",
        persona: "milky-green",
        options: { url: `https://a.example/${"a".repeat(2048)}` },
      },
      400,
      "invalid-url",
    ],
    ["no URL", { command: "expand", persona: "milky-green" }, 400, "invalid-url"],
    [
      "no batch",
      { command: "pipeline", persona: "milky-green", options: {} },
      400,
      "invalid-option",
    ],
    [
      "no batch for the download stage",
      {
        command: "pipeline",
        persona: "milky-green",
        options: { stages: ["download", "refine"] },
      },
      400,
      "invalid-option",
    ],
    ["a batch path", pipeline({ batch: "../../credentials" }), 400, "invalid-option"],
    ["a batch starting with -", pipeline({ batch: "--yt-dlp-args=x" }), 400, "invalid-option"],
    [
      "a batch the persona hasn't",
      pipeline({ batch: "videos-1999-01-01-000000" }),
      400,
      "invalid-option",
    ],
    [
      "another persona's batch",
      { command: "download", persona: "alice", options: { batch: BATCH } },
      400,
      "invalid-option",
    ],
    ["no stages", pipeline({ stages: [] }), 400, "invalid-option"],
    ["a stage twice", pipeline({ stages: ["download", "download"] }), 400, "invalid-option"],
    ["an unknown stage", pipeline({ stages: ["upload"] }), 400, "invalid-option"],
    ["stages as a string", pipeline({ stages: "download" }), 400, "invalid-option"],
    ["a concurrency of 0", pipeline({ transcribeConcurrency: 0 }), 400, "invalid-option"],
    [
      "a concurrency past Soniox's cap",
      pipeline({ transcribeConcurrency: 26 }),
      400,
      "invalid-option",
    ],
    ["a fractional concurrency", pipeline({ transcribeConcurrency: 1.5 }), 400, "invalid-option"],
    ["a concurrency as text", pipeline({ transcribeConcurrency: "4" }), 400, "invalid-option"],
    ["a flag that isn't boolean", pipeline({ abortOnError: "yes" }), 400, "invalid-option"],
    [
      "refresh that isn't boolean",
      { command: "plan", persona: "milky-green", options: { refresh: 1 } },
      400,
      "invalid-option",
    ],
    [
      "an unknown video",
      {
        command: "transcribe",
        persona: "milky-green",
        options: { video: "BV1zzzzzzzzz", date: "2024-01-01" },
      },
      400,
      "invalid-option",
    ],
    [
      "a video path",
      {
        command: "transcribe",
        persona: "milky-green",
        options: { video: "../../x", date: "2024-01-01" },
      },
      400,
      "invalid-option",
    ],
    [
      "no date",
      { command: "transcribe", persona: "milky-green", options: { video: VIDEO } },
      400,
      "invalid-option",
    ],
    [
      "a date that never was",
      {
        command: "transcribe",
        persona: "milky-green",
        options: { video: VIDEO, date: "2023-02-29" },
      },
      400,
      "invalid-option",
    ],
    [
      "a date starting with -",
      { command: "transcribe", persona: "milky-green", options: { video: VIDEO, date: "-1" } },
      400,
      "invalid-option",
    ],
  ];

  for (const [label, body, status, code] of cases) {
    test(label, () => {
      const error = refused(body);
      expect({ status: error.status as number, code: error.code as string }).toEqual({
        status,
        code,
      });
    });
  }

  test("messages never echo what the request sent", () => {
    for (const [, body] of cases) {
      const { message } = refused(body);
      for (const sent of [
        "--exec",
        "../",
        "nobody",
        "generate-image",
        "Milky Green",
        "/etc/passwd",
        "credentials",
      ]) {
        expect([message, message.includes(sent)]).toEqual([message, false]);
      }
    }
  });

  test("an empty stage list is refused rather than read as every stage", () => {
    // The CLI reads `--stages ""` as all four, transcribe and refine included.
    expect(parseArgs(PIPELINE_PARSER, ["--stages", "", "--", batch]).stages).toEqual([
      "download",
      "transcribe",
      "refine",
      "ingest",
    ]);
    expect(refused(pipeline({ stages: [] })).code).toBe("invalid-option");
  });
});

test("JobRequest types each command's options", () => {
  const requests: JobRequest[] = [
    { command: "pipeline", persona: "p", options: { batch: "b", stages: ["download"] } },
    { command: "pipeline", persona: "p", options: { stages: ["transcribe", "refine"] } },
    { command: "refine", persona: "p" },
    { command: "plan", persona: "p", options: { refresh: true } },
    { command: "expand", persona: "p", options: { url: "https://a.example/" } },
  ];
  // @ts-expect-error a pipeline names its batch
  const noBatch: JobRequest = { command: "pipeline", persona: "p" };
  const noBatchToDownload: JobRequest = {
    command: "pipeline",
    persona: "p",
    // @ts-expect-error the download stage reads a batch
    options: { stages: ["download", "refine"] },
  };
  // @ts-expect-error refine takes no options
  const extra: JobRequest = { command: "refine", persona: "p", options: { force: true } };
  // @ts-expect-error generate-image is no job
  const image: JobRequest = { command: "generate-image", persona: "p" };
  expect([...requests, noBatch, noBatchToDownload, extra, image]).toHaveLength(9);
});
