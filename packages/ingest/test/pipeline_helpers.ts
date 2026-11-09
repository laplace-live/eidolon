// fixtures/pipeline/golden.json holds the pipeline's stage parsing, summaries, transcribe planning
// and command runs for the inputs it lists: "<WORK>" stands for a run's folder, "<HOME>" for its
// data home and "<PYTHON>" for the interpreter in a recorded command line. Fakes for what the
// pipeline's stages reach out to: Soniox, the refine provider and the embedding API.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consoleSink, type LogLevel, type LogRecord, logger } from "@eidolon/config";
import { type EmbeddingClient, EmbeddingUsage } from "@eidolon/retrieval";
import type { FakeJob } from "./fake_soniox.ts";

export const PIPELINE_FIXTURES = join(import.meta.dir, "fixtures", "pipeline");

export interface SummaryGolden {
  readonly stages: string[];
  readonly vods_dir: string;
  readonly duration: number;
  readonly download?: [number, number, number, number, number];
  readonly transcribe?: [number, number, number, number, string[], number];
  readonly refine?: [number, number];
  readonly ingest?: [number, number];
  readonly aborted?: boolean;
  readonly text: string;
}

export interface MainGolden {
  readonly name: string;
  readonly argv: string[];
  readonly list?: string;
  readonly vods?: Record<string, string | null>;
  readonly streams?: Record<string, string>;
  readonly rc: Record<string, number>;
  readonly code: number | null;
  readonly raises: string | null;
  readonly stdout: string;
  readonly stderr: string[];
  readonly logs: [string, string][];
  readonly calls: string[][];
  readonly files: string[] | null;
}

export interface PipelineGolden {
  readonly printed_by: string;
  readonly stages: { raw: string; stages?: string[]; error?: string }[];
  readonly summaries: SummaryGolden[];
  readonly plan: {
    readonly vods: Record<string, string | null>;
    readonly streams: string[];
    readonly files: string[];
    readonly logs: [string, string][];
    readonly counts: Record<
      "total" | "skipped" | "skipped_no_date" | "succeeded" | "failed",
      number
    >;
    readonly jobs: [string, string, string][];
    readonly empty_logs: [string, string][];
    readonly never_created: boolean;
  };
  readonly main: MainGolden[];
  readonly help: [string, string];
}

export const pipelineGolden = JSON.parse(
  readFileSync(join(PIPELINE_FIXTURES, "golden.json"), "utf8"),
) as PipelineGolden;

/** The golden's command run named `name`. */
export function mainCase(name: string): MainGolden {
  const found = pipelineGolden.main.find((scenario) => scenario.name === name);
  if (found === undefined) throw new Error(`no golden scenario ${name}`);
  return found;
}

/** Writes each audio file, and its info.json unless null. */
export function writeVods(dir: string, vods: Readonly<Record<string, string | null>>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, info] of Object.entries(vods)) {
    writeFileSync(join(dir, name), "audio");
    if (info !== null) writeFileSync(join(dir, name.replace(/\.[^.]*$/, ".info.json")), info);
  }
}

/** A transcript as transcribe writes one, with `scenes` H2 sections. */
export function transcriptText(streamId: string, date: string, scenes: number): string {
  const sections = Array.from(
    { length: scenes },
    (_, i) => `## ${String(i * 5).padStart(2, "0")}:00 — 第${i}段\n\n内容${i}。`,
  );
  return `---\nstream_date: ${date}\nstream_id: ${streamId}\n---\n\n${sections.join("\n\n")}\n`;
}

/** A refined chunk as refine writes one (v2: it has details and key_quotes). */
export function refinedChunk(heading: string, chunkType = "chat"): Record<string, unknown> {
  return {
    heading,
    summary: `${heading}的摘要`,
    details: `${heading}的细节`,
    chunk_type: chunkType,
    topics: ["话题"],
    mentions: [],
    key_quotes: [],
    sc_events: [],
    songs: [],
    events: [],
    promises: [],
  };
}

/** A sidecar refining chunks `0 .. refined - 1` of `streamId`. */
export function sidecarText(streamId: string, refined: number): string {
  const chunks = Object.fromEntries(
    Array.from({ length: refined }, (_, i) => [
      `${streamId}::${String(i).padStart(3, "0")}`,
      refinedChunk(`标题${i}`),
    ]),
  );
  return JSON.stringify({ schema_version: 2, stream_id: streamId, chunks }, null, 2);
}

const TRANSCRIBE_GOLDEN = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "transcribe", "run.golden.json"), "utf8"),
) as { scenarios: { name: string; jobs: FakeJob[] }[] };

/**
 * Soniox's job for the n-th upload of a run: transcribe's golden job (two scenes) under its own
 * ids, so a run can serve several.
 */
export function sonioxJob(n: number): FakeJob {
  const job = (TRANSCRIBE_GOLDEN.scenarios[0] as { jobs: FakeJob[] }).jobs[0] as FakeJob;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const fileId = `file-${n}`;
  const retag = (record: Record<string, unknown>) => ({ ...record, id, file_id: fileId });
  return {
    file: { ...job.file, id: fileId },
    created: retag(job.created) as FakeJob["created"],
    polls: job.polls.map(retag),
    transcript: { ...job.transcript, id },
  };
}

const EXTRACT = {
  sc_events: [],
  songs: [],
  events: ["打招呼"],
  promises: [],
  topics: ["开场"],
  mentions: [],
  key_quotes: ["你好。"],
  is_anime_audio_dominant: false,
  is_karaoke_dominant: false,
};
const SYNTHESIS = {
  heading: "开场打招呼",
  summary: "我开播和大家打招呼。",
  details: "我一开播就和大家打招呼。",
  chunk_type: "opening",
};

/**
 * The refine provider: a valid answer to every extract and synthesize request, or `status` with
 * an error body for every request when given. `calls` counts the requests.
 */
export function fakeRefine(status?: number): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const fake = async (_input: unknown, init?: RequestInit): Promise<Response> => {
    calls++;
    if (status !== undefined) {
      return Response.json({ error: { message: "refine test" } }, { status });
    }
    const body = JSON.parse(init?.body as string) as {
      response_format: { json_schema: { name: string } };
    };
    const extract = body.response_format.json_schema.name === "ExtractResult";
    return Response.json({
      id: "gen-test",
      object: "chat.completion",
      created: 1767225600,
      model: "test/model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: JSON.stringify(extract ? EXTRACT : SYNTHESIS) },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
    });
  };
  return { fetch: fake as unknown as typeof fetch, calls: () => calls };
}

/** One fetch for a run: Soniox's API to `soniox`, everything else to `other`. */
export function routeFetch(soniox: typeof fetch, other: typeof fetch): typeof fetch {
  const route = (input: unknown, init?: RequestInit) =>
    new URL(String(input)).hostname.endsWith("soniox.com")
      ? soniox(input as Request, init)
      : other(input as Request, init);
  return route as unknown as typeof fetch;
}

/** An embedding API answering every batch with vectors of the asked-for size; or failing. */
export function fakeEmbeddings(
  fail = false,
): Pick<EmbeddingClient, "embedWithUsage"> & { batches: number[] } {
  const batches: number[] = [];
  return {
    batches,
    async embedWithUsage(texts, options) {
      if (fail) throw new Error("embedding test failure");
      batches.push(texts.length);
      const vectors = texts.map((text, i) =>
        Array.from({ length: options.dimensions }, (_, k) => ((text.length + i + k) % 7) / 7),
      );
      const usage = new EmbeddingUsage({
        promptTokens: texts.length,
        totalTokens: texts.length,
        costUsd: 0.00001 * texts.length,
        costSource: "openrouter",
      });
      return [vectors, usage];
    },
  };
}

/** Durations as the golden masks them. */
export function maskDurations(text: string): string {
  return text.replace(/\(\d+\.\ds\)/g, "(<D>s)").replace(/(Duration: +)\d+\.\ds/g, "$1<D>s");
}

/** Records every log line until `stop`, which restores the console sink. */
export function captureLogs(): { readonly records: [LogLevel, string][]; stop(): void } {
  const records: [LogLevel, string][] = [];
  logger.setSink((record: LogRecord) => {
    records.push([record.level, record.message]);
  });
  return {
    records,
    stop() {
      logger.setSink(consoleSink);
    },
  };
}
