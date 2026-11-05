import { describe, expect, test } from "bun:test";
import type { PlanVideo } from "@eidolon/ingest/progress";
import {
  downloadBatches,
  estimateAudioBytes,
  hasPaidWork,
  isFinished,
  isKnown,
  needsFfmpeg,
  parseLinks,
  planTotals,
  runBatch,
  summarizeEntries,
  uniqueEntries,
} from "./videos";

function video(id: string, extra: Partial<PlanVideo> = {}): PlanVideo {
  return {
    id,
    download: "done",
    transcribe: "done",
    refine: { chunks: 10, done: 10 },
    indexed: true,
    estimate: { transcribeUsd: 0, refineUsd: 0, basis: "price-table" },
    ...extra,
  };
}

describe("parseLinks", () => {
  test("keeps http(s) links once each, and skips blanks and comments", () => {
    const text = [
      " https://www.bilibili.com/video/BV1xx411c7mD ",
      "",
      "# a note",
      "https://www.youtube.com/playlist?list=PL1",
      "https://www.bilibili.com/video/BV1xx411c7mD",
    ].join("\r\n");
    expect(parseLinks(text)).toEqual({
      urls: [
        "https://www.bilibili.com/video/BV1xx411c7mD",
        "https://www.youtube.com/playlist?list=PL1",
      ],
      invalid: [],
    });
  });

  test("refuses what the server would", () => {
    const bad = [
      "BV1xx411c7mD",
      "ftp://example.com/a",
      "--exec=touch x",
      "https://exa mple.com",
      "javascript:alert(1)",
      `https://example.com/${"a".repeat(2048)}`,
    ];
    expect(parseLinks(bad.join("\n"))).toEqual({ urls: [], invalid: bad });
  });
});

describe("link checks", () => {
  const entries = [
    { url: "https://b/BV1", id: "BV1", durationSec: 3600 },
    { url: "https://b/BV2", id: "BV2" },
    { url: "https://b/BV1?p=1", id: "BV1", durationSec: 3600 },
    { url: "https://b/BV3", id: "BV3", durationSec: 60 },
  ];

  test("each video once, by id", () => {
    expect(uniqueEntries(entries).map((entry) => entry.id)).toEqual(["BV1", "BV2", "BV3"]);
  });

  test("lengths add up, and the unknown ones are counted", () => {
    expect(summarizeEntries(uniqueEntries(entries))).toEqual({
      count: 3,
      durationSec: 3660,
      unknownDuration: 1,
    });
  });

  test("a video is known by its id, its parts or its URL", () => {
    const videos = [video("BV1_p1"), video("BV9", { url: "https://b/BV3" })];
    expect(entries.map((entry) => isKnown(entry, videos))).toEqual([true, false, true, true]);
    expect(isKnown({ url: "https://b/BV10", id: "BV10" }, [video("BV1")])).toBe(false);
  });

  test("an hour of audio is about 86 MB, rounding up the usual bitrates", () => {
    expect(estimateAudioBytes(3600)).toBe(86_400_000);
  });
});

describe("a plan's videos", () => {
  test("ffmpeg is only for audio over 300 minutes", () => {
    expect(needsFfmpeg(video("a", { durationSec: 300 * 60 }))).toBe(false);
    expect(needsFfmpeg(video("a", { durationSec: 300 * 60 + 1 }))).toBe(true);
    expect(needsFfmpeg(video("a"))).toBe(false);
  });

  test("what is finished, and what a paid run would still do", () => {
    const noSpeech = video("a", { transcribe: "no-speech", indexed: false, refine: null });
    const toTranscribe = video("b", { transcribe: "pending", refine: null, indexed: false });
    const toRefine = video("c", { refine: { chunks: 10, done: 4 }, indexed: false });
    const toIndex = video("d", { indexed: false });
    const noDate = video("e", { transcribe: "no-date", refine: null, indexed: false });
    expect([noSpeech, toTranscribe, toRefine, toIndex, noDate].map(isFinished)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect([noSpeech, toTranscribe, toRefine, toIndex, noDate].map(hasPaidWork)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  test("download batches are the ones with videos still to fetch, oldest first", () => {
    const videos = [
      video("a", { download: "pending", batch: "videos-2026-11-05-120000" }),
      video("b", { download: "pending", batch: "videos-2026-11-01-090000" }),
      video("c", { download: "pending" }),
      video("d", { batch: "videos-2026-10-01-090000" }),
    ];
    expect(downloadBatches(videos)).toEqual([
      "videos-2026-11-01-090000",
      "videos-2026-11-05-120000",
    ]);
  });

  test("a paid run names the batch asked for, else one with work left, else the newest", () => {
    const videos = [
      video("a", { batch: "videos-1" }),
      video("b", { batch: "videos-3", transcribe: "pending", refine: null, indexed: false }),
      video("c", { batch: "videos-2" }),
    ];
    expect(runBatch(videos, "videos-2")).toBe("videos-2");
    expect(runBatch(videos, "videos-9")).toBe("videos-3");
    expect(runBatch(videos, null)).toBe("videos-3");
    expect(
      runBatch([video("a", { batch: "videos-1" }), video("b", { batch: "videos-2" })], null),
    ).toBe("videos-2");
    expect(runBatch([video("a")], null)).toBeNull();
    expect(runBatch([], "videos-new")).toBeNull();
  });

  test("totals add up the work and the estimates, and count what can't be priced", () => {
    const totals = planTotals([
      video("a"),
      video("b", {
        download: "pending",
        transcribe: "pending",
        refine: null,
        indexed: false,
        estimate: { basis: "unpriced" },
      }),
      video("c", {
        transcribe: "pending",
        refine: null,
        indexed: false,
        estimate: { transcribeUsd: 0.5, refineUsd: 0.25, basis: "price-table" },
      }),
      video("d", {
        refine: { chunks: 8, done: 2 },
        indexed: false,
        estimate: { transcribeUsd: 0, refineUsd: 0.1, basis: "history" },
      }),
      video("e", { transcribe: "no-date", refine: null, indexed: false }),
    ]);
    expect(totals).toEqual({
      videos: 5,
      finished: 1,
      downloadPending: 1,
      transcribePending: 2,
      noDate: 1,
      refineChunks: 6,
      unindexed: 1,
      transcribeUsd: 0.5,
      refineUsd: 0.35,
      unpriced: 1,
      paidWork: 3,
    });
  });
});
