// fixtures/transcribe/render.golden.json holds the rendering's outputs (timestamps, segments,
// scenes, markdown, token dumps) for the synthetic inputs it lists.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadsPy, PyFloat, pyJsonDumps } from "@eidolon/config";
import { transcribe } from "../src/index.ts";

const {
  formatDur,
  formatTs,
  groupSegmentsIntoScenes,
  headingHint,
  isoformat,
  payloadDurationSec,
  payloadParts,
  pyFloorDiv,
  renderMarkdown,
  renderPayload,
  shortTs,
  tokensToSegments,
} = transcribe;

interface Golden {
  short_ts: [number, string][];
  format_ts: [number, string][];
  format_dur: [number, string][];
  hints: [string, string][];
  tokens_to_segments: Record<
    string,
    { tokens: [string, number | null, number | null][]; segments: [number, number, string][] }
  >;
  floor_div_300: [number, number][];
  scenes: {
    name: string;
    window: number;
    segments: [number, number, string][];
    scenes: { start: number; end: number; text: string }[];
  }[];
  render: {
    args: {
      stream_date: string;
      stream_id: string;
      duration_min: number;
      source_file: string;
      language: string | null;
      scenes: { start: number; end: number; text: string }[];
    };
    markdown: string;
  }[];
  created_at: [string, string][];
  token_dumps: [string, string][];
}

const golden = (await Bun.file(
  join(import.meta.dir, "fixtures/transcribe/render.golden.json"),
).json()) as Golden;

const toTokens = (rows: [string, number | null, number | null][]) =>
  rows.map(([text, start_ms, end_ms]) => ({ text, start_ms, end_ms }));
const toSegments = (rows: [number, number, string][]) =>
  rows.map(([start, end, text]) => ({ start, end, text }));

test("timestamps and durations format as Python's", () => {
  expect(golden.short_ts.map(([v]) => [v, shortTs(v)])).toEqual(golden.short_ts);
  expect(golden.format_ts.map(([v]) => [v, formatTs(v)])).toEqual(golden.format_ts);
  expect(golden.format_dur.map(([v]) => [v, formatDur(v)])).toEqual(golden.format_dur);
});

test("a heading hint is the first sentence, cut at 60 code points", () => {
  expect(golden.hints.map(([text]) => [text, headingHint(text)])).toEqual(golden.hints);
});

test("tokens join bare into segments, as _tokens_to_segments groups them", () => {
  for (const [name, { tokens, segments }] of Object.entries(golden.tokens_to_segments)) {
    expect([name, tokensToSegments(toTokens(tokens))]).toEqual([name, toSegments(segments)]);
  }
});

test("floor division is CPython's, near every window boundary", () => {
  expect(golden.floor_div_300.map(([v]) => [v, pyFloorDiv(v, 300)])).toEqual(golden.floor_div_300);
});

test("segments fall into the window they start in", () => {
  for (const { name, window, segments, scenes } of golden.scenes) {
    expect([name, groupSegmentsIntoScenes(toSegments(segments), window)]).toEqual([name, scenes]);
  }
});

test("the markdown is Python's byte for byte", () => {
  for (const { args, markdown } of golden.render) {
    const meta = {
      streamDate: args.stream_date,
      streamId: args.stream_id,
      durationMin: args.duration_min,
      sourceFile: args.source_file,
      language: args.language,
    };
    expect(renderMarkdown(meta, args.scenes)).toBe(markdown);
  }
});

test("Soniox's timestamps print as Python's datetime.isoformat()", () => {
  expect(golden.created_at.map(([s]) => [s, isoformat(s)])).toEqual(golden.created_at);
});

describe("payload re-rendering", () => {
  const token = (text: string, start: number | null, end: number | null) => ({
    text,
    start_ms: start,
    end_ms: end,
    confidence: new PyFloat(1),
  });

  test("a sliced payload splits back at each part's offset, so no segment spans a cut", () => {
    const offset = 9337.6974165;
    const offsetMs = Math.trunc(offset * 1000);
    const payload = {
      sliced: true,
      parts: [
        { offset_sec: 0, duration_sec: offset, audio_duration_ms: 9_337_280 },
        { offset_sec: offset, duration_sec: offset, audio_duration_ms: null },
      ],
      transcript: {
        tokens: [
          token("在", 9_336_000, 9_336_100),
          token("。", 9_336_200, 9_336_300),
          token("x", null, null),
          token("那", offsetMs + 100, offsetMs + 200),
          token("座", offsetMs + 300, offsetMs + 400),
        ],
      },
    };
    const parts = payloadParts(payload);
    expect(parts.map((p) => p.tokens.map((t) => t.text))).toEqual([
      ["在", "。", "x"],
      ["那", "座"],
    ]);
    const md = renderPayload(payload, {
      streamDate: "2022-09-27",
      streamId: "2022-09-27-BVx",
      sourceFile: "BVx.m4a",
      language: "zh",
    });
    // One list would bridge the cut into a single "在。那座" segment.
    expect(md).toContain("在。 那座");
    expect(payloadDurationSec(payload)).toBe(9_337.28 + offset);
    expect(md).toContain("duration_min: 311\n");
  });

  test("a single payload's duration is Soniox's measurement", () => {
    expect(payloadDurationSec({ audio_duration_ms: 8_622_741 })).toBe(8_622.741);
    expect(payloadDurationSec({ audio_duration_ms: null })).toBe(0);
  });
});

test("token dumps keep the SDK's field order, null-filled, and confidence as a float", () => {
  // As the client parses a transcript: keeping Python's floats.
  for (const [token, text] of golden.token_dumps) {
    const parsed = loadsPy(token) as Record<string, unknown>;
    expect(pyJsonDumps(transcribe.dumpToken(parsed), { ensureAscii: false, indent: 2 })).toBe(text);
  }
});
