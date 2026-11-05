import { expect, test } from "bun:test";
import { ndjsonSink, noProgress, type ProgressEvent, SUMMARY_COUNTS } from "../src/index.ts";

test("ndjsonSink writes one JSON line per event, stamped with v and t", () => {
  const lines: string[] = [];
  const sink = ndjsonSink(
    (line) => lines.push(line),
    () => 1_786_729_091_000,
  );
  sink({ type: "stage", stage: "download", status: "start", total: 2 });
  sink({
    type: "item",
    stage: "download",
    item: "https://www.bilibili.com/video/BV1FbgM6QEw3",
    status: "done",
    outputs: ["BV1FbgM6QEw3_p1"],
    message: undefined,
  });
  expect(lines).toEqual([
    '{"v":1,"t":1786729091000,"type":"stage","stage":"download","status":"start","total":2}\n',
    '{"v":1,"t":1786729091000,"type":"item","stage":"download",' +
      '"item":"https://www.bilibili.com/video/BV1FbgM6QEw3","status":"done",' +
      '"outputs":["BV1FbgM6QEw3_p1"]}\n',
  ]);
});

test("noProgress takes any event and does nothing", () => {
  const summary: ProgressEvent = {
    type: "summary",
    stage: "pipeline",
    ok: false,
    cancelled: true,
    counts: {},
    durationSec: 1.5,
  };
  expect(noProgress(summary)).toBeUndefined();
});

test("each summary's counts are pinned by name, the plan's and the pipeline run's included", () => {
  expect(SUMMARY_COUNTS.download).toEqual(["requested", "succeeded", "failed", "newFiles"]);
  expect(Object.keys(SUMMARY_COUNTS)).toEqual([
    "download",
    "expand",
    "transcribe",
    "refine",
    "ingest-streams",
    "ingest-facts",
    "catalog",
    "plan",
    "pipeline",
  ]);
  expect(SUMMARY_COUNTS.plan).toEqual([
    "videos",
    "downloadPending",
    "transcribePending",
    "noDate",
    "refinePending",
    "unindexed",
  ]);
  expect(SUMMARY_COUNTS.pipeline).toEqual(["stages", "failed", "aborted"]);
});
