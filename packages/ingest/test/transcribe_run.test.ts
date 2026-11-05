// fixtures/transcribe/run.golden.json is tools/transcribe.py's main() run through the soniox SDK
// against a fake Soniox serving the jobs it lists (its `printed_by` names the versions): the
// requests Python made and the files it wrote. The TS run is served the same jobs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import { type ProgressEvent, transcribe } from "../src/index.ts";
import {
  type FakeJob,
  fakeBinaries,
  fakeSoniox,
  type Recorded,
  sonioxError,
} from "./fake_soniox.ts";

const { transcribeAudio, transcriptState, audioStatus, listAudioFiles, TranscribeError } =
  transcribe;

const FIXTURES = join(import.meta.dir, "fixtures/transcribe");

interface Scenario {
  name: string;
  audio: string;
  date: string;
  duration: number;
  args: string[];
  jobs: FakeJob[];
  exit_code: number;
  requests: Recorded[];
  md: string | null;
  payload: string | null;
}

const golden = (await Bun.file(join(FIXTURES, "run.golden.json")).json()) as {
  scenarios: Scenario[];
};
const scenario = (name: string): Scenario =>
  golden.scenarios.find((s) => s.name === name) as Scenario;

let work = "";
let logs: [string, string][] = [];
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "ingest-transcribe-"));
  logs = [];
  logger.setSink((record: LogRecord) => {
    logs.push([record.level, record.message]);
  });
});
afterEach(() => {
  logger.setSink(consoleSink);
  rmSync(work, { recursive: true, force: true });
});

const noSleep = async (): Promise<void> => {};

/** The library options Python's flags in a golden scenario stand for. */
function optionsFor(args: readonly string[]): Partial<transcribe.TranscribeOptions> {
  const options: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--context-file") options.contextFile = args[++i]?.replace("<FIXTURES>", FIXTURES);
    else if (arg === "--no-context") options.contextFile = null;
    else if (arg === "--auto-slice") options.autoSlice = true;
    else if (arg === "--language") options.language = args[++i] || null;
    else if (arg === "--window") options.windowSec = Number(args[++i]);
  }
  return options;
}

function setup(audioName: string, durationSec: number | null) {
  const audio = join(work, audioName);
  writeFileSync(audio, Buffer.alloc(2048));
  return { audio, outDir: join(work, "streams"), ...fakeBinaries(work, durationSec) };
}

/**
 * What Python's requests become in TS: the SDK's destroy fetched the transcription again before
 * deleting it, where TS already knows its file; and TS deletes only after writing the transcript,
 * so a sliced run's deletes all come last.
 */
function expectedRequests(python: readonly Recorded[]): Recorded[] {
  const out: Recorded[] = [];
  const deletes: Recorded[] = [];
  python.forEach((request, i) => {
    const next = python[i + 1];
    if (request.method === "GET" && next?.method === "DELETE" && next.path === request.path) return;
    (request.method === "DELETE" ? deletes : out).push(request);
  });
  return [...out, ...deletes];
}

const strip = (requests: readonly Recorded[]): Recorded[] =>
  requests.map(({ method, path, form, json }) => ({
    method,
    path,
    ...(form ? { form } : {}),
    ...(json ? { json } : {}),
  }));

describe("against Python's run", () => {
  for (const s of golden.scenarios) {
    test(`${s.name}: Soniox gets Python's requests, and the files are Python's byte for byte`, async () => {
      const { audio, outDir, ffprobe, ffmpeg } = setup(s.audio, s.duration);
      const soniox = fakeSoniox(s.jobs);
      const events: ProgressEvent[] = [];
      const result = await transcribeAudio({
        audioPath: audio,
        date: s.date,
        outDir,
        apiKey: "test-key",
        ...optionsFor(s.args),
        fetch: soniox.fetch,
        sleep: noSleep,
        ffprobe,
        ffmpeg,
        onProgress: (event) => events.push(event),
      });
      const stem = `${s.date}-${s.audio.replace(/\.m4a$/, "")}`;
      expect(readFileSync(join(outDir, `${stem}.md`), "utf8")).toBe(s.md as string);
      expect(readFileSync(join(outDir, `${stem}.soniox.json`), "utf8")).toBe(s.payload as string);
      const deletes = (r: Recorded[]) => r.filter((x) => x.method === "DELETE");
      const rest = (r: Recorded[]) => r.filter((x) => x.method !== "DELETE");
      const expected = expectedRequests(s.requests);
      expect(rest(strip(soniox.requests))).toEqual(rest(strip(expected)));
      expect(new Set(deletes(strip(soniox.requests)).map((r) => r.path))).toEqual(
        new Set(deletes(strip(expected)).map((r) => r.path)),
      );
      for (const request of soniox.requests) {
        expect(request.authorization).toBe("Bearer test-key");
        expect(request.timeout).toBe(600_000);
      }
      expect(result).toMatchObject({ status: "done", streamId: stem, tokens: expect.any(Number) });
      expect(events.map((e) => (e.type === "item" ? e.status : e.type))).toEqual(["start", "done"]);
      expect(events[1]).toMatchObject({ item: s.audio, video: s.audio.replace(".m4a", "") });
      expect(existsSync(join(outDir, `${stem}.md.${process.pid}.tmp`))).toBe(false);
    });
  }

  test("a sliced run cuts each part with Python's ffmpeg argv", async () => {
    const s = scenario("sliced");
    const { audio, outDir, ffprobe, ffmpeg, ffmpegLog } = setup(s.audio, s.duration);
    await transcribeAudio({
      audioPath: audio,
      date: s.date,
      outDir,
      apiKey: "k",
      ...optionsFor(s.args),
      fetch: fakeSoniox(s.jobs).fetch,
      sleep: noSleep,
      ffprobe,
      ffmpeg,
    });
    const runs = readFileSync(ffmpegLog, "utf8").split("---\n").filter(Boolean);
    const argv = (start: string, duration: string, part: string) => {
      const args = [
        ...["-nostdin", "-loglevel", "error", "-y", "-ss", start, "-t", duration, "-i", audio],
        ...["-c", "copy", "-vn", "-map_metadata", "-1", part],
      ];
      return `${args.join("\n")}\n`;
    };
    expect(runs.map((run) => run.replace(/\n[^\n]*laplace-slice-[^/]*\//, "\n"))).toEqual([
      argv("0.000", "9337.697", "part_01_of_02.m4a"),
      argv("9337.697", "9337.697", "part_02_of_02.m4a"),
    ]);
    expect(logs).toContainEqual([
      "INFO",
      "Auto-slicing BV1bbbbbbbbb.m4a: 311.3 min → 2 parts × ~155.6 min (cap=280 min/part)",
    ]);
  });
});

function job(id: string, tokens: unknown[], audioMs: number | null = 5_000): FakeJob {
  const meta = { id, filename: "a.m4a", created_at: "2026-01-02T03:04:05.678Z" };
  return {
    file: { id: `file-${id}`, filename: "a.m4a" },
    created: { ...meta, status: "queued", audio_duration_ms: null },
    polls: [{ ...meta, status: "completed", audio_duration_ms: audioMs }],
    transcript: { id, text: "", tokens },
  };
}

const SPEECH = [{ text: "你好。", start_ms: 0, end_ms: 4_000, confidence: 0.9 }];

async function run(
  jobs: FakeJob[],
  options: Partial<transcribe.TranscribeOptions> & { override?: Parameters<typeof fakeSoniox>[1] },
) {
  const { audio, outDir, ffprobe, ffmpeg } = setup("a.m4a", 60);
  const soniox = fakeSoniox(jobs, options.override);
  const events: ProgressEvent[] = [];
  const promise = transcribeAudio({
    audioPath: audio,
    date: "2026-01-02",
    outDir,
    apiKey: "k",
    contextFile: null,
    fetch: soniox.fetch,
    sleep: noSleep,
    retryDelaysMs: [1, 1],
    ffprobe,
    ffmpeg,
    onProgress: (event) => events.push(event),
    ...options,
  });
  return { promise, soniox, events, outDir, audio };
}

const paths = (requests: readonly Recorded[]) => requests.map((r) => `${r.method} ${r.path}`);

describe("no speech", () => {
  test("only the payload is written, and it marks the audio done", async () => {
    const { promise, events, outDir } = await run([job("t1", [])], {});
    const result = await promise;
    expect(result).toMatchObject({ status: "no-speech", scenes: 0, tokens: 0 });
    expect(existsSync(join(outDir, "2026-01-02-a.md"))).toBe(false);
    const payload = JSON.parse(readFileSync(join(outDir, "2026-01-02-a.soniox.json"), "utf8"));
    expect(payload.transcript.tokens).toEqual([]);
    expect(events.at(-1)).toMatchObject({ status: "done", code: "no-speech" });
    expect(transcriptState(outDir, "2026-01-02", "a")).toBe("no-speech");
  });

  test("tokens that render no segment count as no speech too", async () => {
    const blank = [{ text: " ", start_ms: 0, end_ms: 0 }, { text: "x" }];
    const { promise, outDir } = await run([job("t1", blank)], {});
    expect((await promise).status).toBe("no-speech");
    expect(transcriptState(outDir, "2026-01-02", "a")).toBe("no-speech");
  });

  test("a forced run that now hears nothing removes the old transcript", async () => {
    const { audio, outDir, ffprobe } = setup("a.m4a", 60);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "2026-01-02-a.md"), "old");
    await transcribeAudio({
      audioPath: audio,
      date: "2026-01-02",
      outDir,
      apiKey: "k",
      contextFile: null,
      fetch: fakeSoniox([job("t1", [])]).fetch,
      sleep: noSleep,
      ffprobe,
    });
    expect(existsSync(join(outDir, "2026-01-02-a.md"))).toBe(false);
  });
});

describe("Soniox failures", () => {
  test("the uploaded file is deleted when creating the transcription fails", async () => {
    const { promise, soniox, events, outDir } = await run([job("t1", SPEECH)], {
      override: (r) =>
        r.method === "POST" && r.path === "/transcriptions"
          ? sonioxError(400, "invalid_request", "bad context")
          : undefined,
    });
    await expect(promise).rejects.toThrow("bad context (HTTP 400, invalid_request)");
    expect(paths(soniox.requests)).toEqual([
      "POST /files",
      "POST /transcriptions",
      "DELETE /files/file-t1",
    ]);
    expect(events.at(-1)).toMatchObject({ status: "failed", message: expect.any(String) });
    expect(existsSync(join(outDir, "2026-01-02-a.soniox.json"))).toBe(false);
  });

  test("a failed job is deleted and fails the item", async () => {
    const failed = job("t1", SPEECH);
    const polls = [{ ...failed.polls[0], status: "error", error_type: "x", error_message: "y" }];
    const { promise, soniox } = await run([{ ...failed, polls }], {});
    await expect(promise).rejects.toThrow(new TranscribeError("Soniox job failed: x: y"));
    expect(paths(soniox.requests).slice(-2)).toEqual([
      "DELETE /transcriptions/t1",
      "DELETE /files/file-t1",
    ]);
  });

  test("polls and the transcript fetch ride out network errors and retryable statuses", async () => {
    let failures = 0;
    const { promise, soniox } = await run([job("t1", SPEECH)], {
      retryDelaysMs: [1, 1, 1],
      override: (r) => {
        if (r.method !== "GET" || failures >= 3) return undefined;
        failures++;
        return failures === 2
          ? sonioxError(503, "service_unavailable", "busy")
          : new TypeError("reset");
      },
    });
    expect((await promise).status).toBe("done");
    expect(paths(soniox.requests).filter((p) => p.startsWith("GET"))).toEqual([
      "GET /transcriptions/t1",
      "GET /transcriptions/t1",
      "GET /transcriptions/t1",
      "GET /transcriptions/t1",
      "GET /transcriptions/t1/transcript",
    ]);
  });

  test("a cleanup that fails only warns", async () => {
    const { promise } = await run([job("t1", SPEECH)], {
      override: (r) =>
        r.method === "DELETE" ? sonioxError(409, "transcription_invalid_state", "busy") : undefined,
    });
    expect((await promise).status).toBe("done");
    expect(logs.filter(([level]) => level === "WARNING").map(([, m]) => m)).toEqual([
      "Failed to cleanup Soniox job t1: busy (HTTP 409, transcription_invalid_state)",
      "Failed to delete Soniox file file-t1: busy (HTTP 409, transcription_invalid_state)",
    ]);
  });

  test("--keep-soniox-files keeps what Soniox made, but not an upload that never became one", async () => {
    const { promise, soniox } = await run([job("t1", SPEECH)], { keepFiles: true });
    await promise;
    expect(paths(soniox.requests).some((p) => p.startsWith("DELETE"))).toBe(false);
    const failed = await run([job("t2", SPEECH)], {
      keepFiles: true,
      override: (r) =>
        r.path === "/transcriptions" ? sonioxError(429, "limit_exceeded", "too many") : undefined,
      retryDelaysMs: [],
    });
    await expect(failed.promise).rejects.toThrow("too many (HTTP 429, limit_exceeded)");
    expect(paths(failed.soniox.requests).at(-1)).toBe("DELETE /files/file-t2");
  });
});

describe("cancelling", () => {
  test("mid-poll: the job and its upload are deleted and the item is cancelled", async () => {
    const controller = new AbortController();
    let polls = 0;
    const { promise, soniox, events, outDir } = await run([job("t1", SPEECH)], {
      signal: controller.signal,
      override: (r) => {
        if (r.method === "GET" && ++polls === 2) {
          controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
          return "hang";
        }
        if (r.method === "GET") return Response.json({ id: "t1", status: "processing" });
        if (r.path === "/transcriptions/t1" && r.method === "DELETE") {
          return sonioxError(409, "transcription_invalid_state", "still processing");
        }
        return undefined;
      },
    });
    await expect(promise).rejects.toThrow("Interrupted by SIGINT");
    expect(paths(soniox.requests).slice(-2)).toEqual([
      "DELETE /transcriptions/t1",
      "DELETE /files/file-t1",
    ]);
    expect(events.at(-1)).toMatchObject({ status: "cancelled", code: "cancelled" });
    expect(existsSync(join(outDir, "2026-01-02-a.soniox.json"))).toBe(false);
  });

  test("mid-upload: nothing is left to delete, and no request goes out after", async () => {
    const controller = new AbortController();
    const { promise, soniox } = await run([job("t1", SPEECH)], {
      signal: controller.signal,
      override: (r) => {
        if (r.path !== "/files") return undefined;
        controller.abort(new DOMException("Interrupted by SIGTERM", "AbortError"));
        return "hang";
      },
    });
    await expect(promise).rejects.toThrow("Interrupted by SIGTERM");
    expect(paths(soniox.requests)).toEqual(["POST /files"]);
  });

  test("a run cancelled before it starts uploads nothing", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
    const { audio, outDir } = setup("a.m4a", 60);
    await expect(
      transcribeAudio({
        audioPath: audio,
        date: "2026-01-02",
        outDir,
        apiKey: "k",
        signal: controller.signal,
        ffprobe: null,
      }),
    ).rejects.toThrow("Interrupted by SIGINT");
  });
});

describe("before anything is uploaded", () => {
  const fails = async (options: Partial<transcribe.TranscribeOptions>, message: string) => {
    const { promise, soniox } = await run([job("t1", SPEECH)], options);
    await expect(promise).rejects.toThrow(message);
    expect(soniox.requests).toEqual([]);
  };

  test("audio over 300 minutes needs --auto-slice", async () => {
    const { audio, outDir, ffprobe } = setup("long.m4a", 18_001);
    const soniox = fakeSoniox([]);
    await expect(
      transcribeAudio({
        audioPath: audio,
        date: "d",
        outDir,
        apiKey: "k",
        fetch: soniox.fetch,
        ffprobe,
      }),
    ).rejects.toThrow(
      new TranscribeError(
        "Audio is 300.0 min — Soniox caps async jobs at 300 min per file. Re-run with " +
          "--auto-slice to chunk it via ffmpeg.",
      ),
    );
    expect(soniox.requests).toEqual([]);
  });

  test("slicing needs ffmpeg", async () => {
    const { audio, outDir, ffprobe } = setup("long.m4a", 18_001);
    await expect(
      transcribeAudio({
        audioPath: audio,
        date: "d",
        outDir,
        apiKey: "k",
        autoSlice: true,
        ffprobe,
        ffmpeg: null,
      }),
    ).rejects.toThrow("ffmpeg not found on PATH — required for --auto-slice.");
  });

  test("without ffprobe the duration comes from the .info.json", async () => {
    const { audio, outDir } = setup("long.m4a", null);
    writeFileSync(join(work, "long.info.json"), JSON.stringify({ duration: 18_675.3 }));
    await expect(
      transcribeAudio({
        audioPath: audio,
        date: "d",
        outDir,
        apiKey: "k",
        ffprobe: null,
        ffmpeg: null,
        autoSlice: true,
      }),
    ).rejects.toThrow("ffmpeg not found on PATH");
    expect(logs).toContainEqual([
      "INFO",
      "ffprobe gave no duration for long.m4a; long.info.json says 18675.3s",
    ]);
  });

  test("--slice-max-min must be in (0, 300]", async () => {
    const { audio, outDir, ffprobe, ffmpeg } = setup("long.m4a", 18_001);
    for (const sliceMaxMin of [0, 301]) {
      await expect(
        transcribeAudio({
          audioPath: audio,
          date: "d",
          outDir,
          apiKey: "k",
          autoSlice: true,
          sliceMaxMin,
          ffprobe,
          ffmpeg,
        }),
      ).rejects.toThrow(`--slice-max-min must be in (0, 300], got ${sliceMaxMin}`);
    }
  });

  test("a language hint is two letters, and the window positive", async () => {
    await fails({ language: "zho" }, "Soniox takes two-letter ISO 639-1 language hints, not 'zho'");
    await fails({ windowSec: 0 }, "The scene window must be a positive number of seconds, not 0.");
  });

  test("a glossary Soniox would reject", async () => {
    await fails(
      { contextFile: join(FIXTURES, "glossary/trap.toml") },
      "general[0] has unexpected keys ['terms', 'text']",
    );
  });
});

describe("skip rules", () => {
  test("a transcript is done; a payload with speech but no transcript is not", () => {
    const dir = join(work, "streams");
    mkdirSync(dir);
    expect(transcriptState(dir, "2026-01-02", "a")).toBe("pending");
    writeFileSync(
      join(dir, "2026-01-02-a.soniox.json"),
      JSON.stringify({ transcript: { tokens: SPEECH } }),
    );
    expect(transcriptState(dir, "2026-01-02", "a")).toBe("pending");
    writeFileSync(join(dir, "2026-01-02-a.soniox.json"), "{not json");
    expect(transcriptState(dir, "2026-01-02", "a")).toBe("pending");
    writeFileSync(join(dir, "2026-01-02-a.md"), "");
    expect(transcriptState(dir, "2026-01-02", "a")).toBe("done");
  });

  test("the pipeline names a stream by the audio's upload date, and skips audio without one", () => {
    const vods = join(work, "vods");
    const streams = join(work, "streams");
    mkdirSync(vods);
    mkdirSync(streams);
    writeFileSync(join(vods, "b.m4a"), "");
    writeFileSync(join(vods, "b.info.json"), JSON.stringify({ upload_date: "20250724" }));
    writeFileSync(join(vods, "a.m4a"), "");
    expect(audioStatus(join(vods, "a.m4a"), streams)).toEqual({ state: "no-date" });
    expect(audioStatus(join(vods, "b.m4a"), streams)).toEqual({
      state: "pending",
      date: "2025-07-24",
      mdPath: join(streams, "2025-07-24-b.md"),
      payloadPath: join(streams, "2025-07-24-b.soniox.json"),
    });
  });

  test("audio files are the folder's own files with an audio suffix, in name order", () => {
    const vods = join(work, "vods");
    mkdirSync(join(vods, "dir.m4a"), { recursive: true });
    for (const name of ["b.opus", "a.m4a", "c.mp4", "d.M4A", ".m4a", "é.mp3", "z.webm"]) {
      writeFileSync(join(vods, name), "");
    }
    expect(listAudioFiles(`${vods}/`)).toEqual(
      ["a.m4a", "b.opus", "z.webm", "é.mp3"].map((name) => join(vods, name)),
    );
    expect(listAudioFiles(join(work, "missing"))).toEqual([]);
  });

  test("a transcription's price comes from Soniox's hourly rate", () => {
    expect(transcribe.estimateTranscribeUsd(3_600, "stt-async-v5")).toBeCloseTo(0.1);
    expect(transcribe.estimateTranscribeUsd(3_600, "some-new-model")).toBeNull();
  });
});
