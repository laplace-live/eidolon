import { describe, expect, test } from "bun:test";
import type { PlanVideo } from "@eidolon/ingest/progress";
import type { JobSnapshot } from "./api";
import {
  costSoFar,
  currentStage,
  EMPTY_JOB_VIEW,
  failedItems,
  type JobEvent,
  type JobView,
  jobOutcome,
  LOG_LIMIT,
  latestJob,
  reduceJob,
  runningItems,
  runSummary,
  type StageView,
  stageFraction,
  videoActivity,
} from "./jobs";

function reduce(...events: JobEvent[]): JobView {
  return reduceJob(EMPTY_JOB_VIEW, events);
}

const summary = (stage: string, ok: boolean, extra: object = {}): JobEvent =>
  ({ type: "summary", stage, ok, counts: {}, durationSec: 1, ...extra }) as JobEvent;

function planVideo(id: string, extra: Partial<PlanVideo> = {}): PlanVideo {
  return {
    id,
    download: "done",
    transcribe: "pending",
    refine: null,
    indexed: false,
    estimate: { basis: "price-table" },
    ...extra,
  };
}

describe("stage, item and progress state", () => {
  const view = reduce(
    { v: 1, t: 1000, type: "stage", stage: "transcribe", status: "start", total: 2 },
    { type: "item", stage: "transcribe", item: "a.m4a", video: "a", status: "start", index: 1 },
    { type: "progress", stage: "transcribe", item: "a.m4a", done: 40, total: 100, unit: "percent" },
    { type: "item", stage: "transcribe", item: "a.m4a", status: "done", costUsd: 0.25 },
    { type: "item", stage: "transcribe", item: "b.m4a", video: "b", status: "start", index: 2 },
    {
      type: "item",
      stage: "transcribe",
      item: "b.m4a",
      status: "failed",
      code: "insufficient-credits",
      provider: "soniox",
      message: "HTTP 402",
    },
    { type: "stage", stage: "transcribe", status: "failed", code: "insufficient-credits" },
  );

  test("a stage keeps its status, total and counts", () => {
    expect(view.stages).toHaveLength(1);
    const [stage] = view.stages;
    expect(stage).toMatchObject({ stage: "transcribe", status: "failed", total: 2, items: 2 });
    expect(stage).toMatchObject({ done: 1, failed: 1, skipped: 0, cancelled: 0 });
    expect(stage?.code).toBe("insufficient-credits");
  });

  test("an item keeps what earlier events said that later ones leave out", () => {
    const [a, b] = view.items;
    expect(a).toMatchObject({ item: "a.m4a", video: "a", status: "done", index: 1, costUsd: 0.25 });
    expect(a?.progress).toEqual({ done: 40, total: 100, unit: "percent" });
    expect(b).toMatchObject({ video: "b", status: "failed", code: "insufficient-credits" });
    expect(b?.provider).toBe("soniox");
  });

  test("the cost so far, the failures and what is still running", () => {
    expect(costSoFar(view)).toBe(0.25);
    expect(failedItems(view).map((item) => item.item)).toEqual(["b.m4a"]);
    expect(runningItems(view)).toEqual([]);
    expect(costSoFar(reduce({ type: "stage", stage: "refine", status: "start" }))).toBeNull();
  });

  test("an item counts once, under the way it ended last", () => {
    const again = reduceJob(view, [
      { type: "item", stage: "transcribe", item: "b.m4a", status: "done" },
      { type: "item", stage: "transcribe", item: "b.m4a", status: "done" },
    ]);
    expect(again.stages[0]).toMatchObject({ done: 2, failed: 0 });
  });

  test("an item before its stage's start opens the stage, and takes the total it carries", () => {
    const early = reduce({
      type: "item",
      stage: "ingest-facts",
      item: "a.txt",
      status: "done",
      index: 1,
      total: 3,
    });
    expect(early.stages[0]).toMatchObject({ stage: "ingest-facts", status: "start", total: 3 });
    expect(early.stages[0]?.done).toBe(1);
  });

  test("a stage's fraction follows its items, then what it reports as a whole", () => {
    const facts = reduce(
      { type: "stage", stage: "ingest-facts", status: "start", total: 2 },
      { type: "item", stage: "ingest-facts", item: "a.txt", status: "done" },
    );
    expect(stageFraction(facts.stages[0] as StageView)).toBe(0.5);
    const embedding = reduceJob(facts, [
      { type: "item", stage: "ingest-facts", item: "b.txt", status: "skipped" },
      { type: "progress", stage: "ingest-facts", done: 30, total: 120, unit: "rows" },
    ]);
    expect(stageFraction(embedding.stages[0] as StageView)).toBe(0.25);
    const streams = reduce(
      { type: "stage", stage: "ingest-streams", status: "start", total: 40 },
      { type: "progress", stage: "ingest-streams", done: 10, total: 40, unit: "files" },
    );
    expect(stageFraction(streams.stages[0] as StageView)).toBe(0.25);
    const unknown = reduce({ type: "stage", stage: "expand", status: "start" });
    expect(stageFraction(unknown.stages[0] as StageView)).toBeNull();
    const done = reduceJob(unknown, [{ type: "stage", stage: "expand", status: "done" }]);
    expect(stageFraction(done.stages[0] as StageView)).toBe(1);
  });

  test("the current stage is the latest still running, not one that opened inside it", () => {
    const download = reduce(
      { type: "stage", stage: "download", status: "start", total: 3 },
      { type: "stage", stage: "setup", status: "start" },
      { type: "stage", stage: "setup", status: "done" },
    );
    expect(currentStage(download)?.stage).toBe("download");
    const done = reduceJob(download, [{ type: "stage", stage: "download", status: "done" }]);
    expect(currentStage(done)?.stage).toBe("setup");
    expect(currentStage(EMPTY_JOB_VIEW)).toBeNull();
  });

  test("progress without a known item belongs to the stage", () => {
    const setup = reduce(
      { type: "stage", stage: "setup", status: "start" },
      { type: "progress", stage: "setup", item: "yt-dlp_macos", done: 5, unit: "bytes" },
    );
    expect(setup.items).toEqual([]);
    expect(setup.stages[0]?.progress).toEqual({ done: 5, total: null, unit: "bytes" });
  });
});

describe("summaries and outcomes", () => {
  const pipeline = (...events: JobEvent[]) =>
    reduce(
      { type: "stage", stage: "download", status: "start", total: 1 },
      { type: "stage", stage: "download", status: "done" },
      summary("download", true),
      ...events,
    );

  test("the pipeline's run summary is its own, not the last stage's", () => {
    const done = pipeline(summary("pipeline", true, { costUsd: 1.5 }));
    expect(runSummary(done, "pipeline")?.stage).toBe("pipeline");
    expect(runSummary(pipeline(), "pipeline")).toBeNull();
    expect(runSummary(reduce(summary("plan", true)), "plan")?.stage).toBe("plan");
    expect(runSummary(reduce(summary("ingest-facts", false)), "ingest-facts")?.ok).toBe(false);
  });

  test("a summary decides how the run ended", () => {
    const job = { command: "pipeline", status: "failed" } as const;
    expect(jobOutcome(pipeline(summary("pipeline", true)), { ...job, status: "succeeded" })).toBe(
      "succeeded",
    );
    expect(jobOutcome(pipeline(summary("pipeline", false)), job)).toBe("failed");
    expect(jobOutcome(pipeline(summary("pipeline", false, { cancelled: true })), job)).toBe(
      "cancelled",
    );
  });

  test("a run that died without its summary crashed, even after a stage's summary", () => {
    expect(jobOutcome(pipeline(), { command: "pipeline", status: "failed" })).toBe("crashed");
    expect(jobOutcome(EMPTY_JOB_VIEW, { command: "ingest-facts", status: "failed" })).toBe(
      "crashed",
    );
    // Exiting 0 is success even without the summary every command writes.
    expect(jobOutcome(EMPTY_JOB_VIEW, { command: "refine", status: "succeeded" })).toBe(
      "succeeded",
    );
  });

  test("cancelled, interrupted and running come from the job, whatever was written", () => {
    const view = pipeline(summary("pipeline", true));
    expect(jobOutcome(view, { command: "pipeline", status: "cancelled" })).toBe("cancelled");
    expect(jobOutcome(view, { command: "pipeline", status: "interrupted" })).toBe("interrupted");
    expect(jobOutcome(view, { command: "pipeline", status: "running" })).toBe("running");
  });
});

describe("entries, plans and the log", () => {
  test("expand entries collect in order", () => {
    const view = reduce(
      { type: "stage", stage: "expand", status: "start" },
      { type: "entry", entry: { url: "https://b/1", id: "BV1", title: "one", durationSec: 60 } },
      { type: "entry", entry: { url: "https://b/2", id: "BV2" } },
      { type: "stage", stage: "expand", status: "done", total: 2 },
      summary("expand", true, { counts: { entries: 2 } }),
    );
    expect(view.entries.map((entry) => entry.id)).toEqual(["BV1", "BV2"]);
    expect(view.stages[0]).toMatchObject({ status: "done", total: 2 });
  });

  test("a plan row per video, the latest winning, and neither plans nor progress in the log", () => {
    const view = reduce(
      { type: "plan", video: planVideo("a") },
      { type: "plan", video: planVideo("b") },
      { type: "plan", video: planVideo("a", { transcribe: "done" }) },
      { type: "progress", stage: "plan", done: 1, unit: "files" },
      summary("plan", true),
    );
    expect(view.plan.map((video) => [video.id, video.transcribe])).toEqual([
      ["a", "done"],
      ["b", "pending"],
    ]);
    expect(view.log.map((line) => line.event.type)).toEqual(["summary"]);
  });

  test("log lines keep the time each was written", () => {
    const view = reduce({ v: 1, t: 42, type: "stage", stage: "refine", status: "start" });
    expect(view.log[0]?.t).toBe(42);
    expect(reduce({ type: "stage", stage: "refine", status: "start" }).log[0]?.t).toBeNull();
  });

  test("the log keeps the newest LOG_LIMIT lines and counts the rest", () => {
    const events: JobEvent[] = Array.from({ length: LOG_LIMIT + 7 }, (_, i) => ({
      type: "item",
      stage: "download",
      item: `https://example.com/${i}`,
      status: "start",
    }));
    const view = reduce(...events);
    expect(view.log).toHaveLength(LOG_LIMIT);
    expect(view.logDropped).toBe(7);
    expect(view.log[0]?.event).toMatchObject({ item: "https://example.com/7" });
    expect(view.items).toHaveLength(LOG_LIMIT + 7);
  });

  test("an event type a newer CLI writes is skipped", () => {
    const view = reduce({ type: "heartbeat" } as unknown as JobEvent);
    expect(view).toEqual(reduce());
    expect(view.log).toEqual([]);
  });
});

describe("reduceJob", () => {
  const events: JobEvent[] = [
    { type: "stage", stage: "refine", status: "start", total: 1 },
    { type: "item", stage: "refine", item: "s1", video: "BV1_p1", status: "start" },
    { type: "progress", stage: "refine", item: "s1", done: 3, total: 9, unit: "chunks" },
    { type: "item", stage: "refine", item: "s1", status: "done", costUsd: 0.01 },
  ];

  test("leaves the view it was given as it was", () => {
    const first = reduce(...events.slice(0, 2));
    const snapshot = structuredClone(first);
    reduceJob(first, events.slice(2));
    expect(first).toEqual(snapshot);
  });

  test("no events give back the same view", () => {
    const view = reduce(...events);
    expect(reduceJob(view, [])).toBe(view);
  });

  test("one batch or one event at a time, the view is the same", () => {
    const stepwise = events.reduce((view, event) => reduceJob(view, [event]), EMPTY_JOB_VIEW);
    expect(stepwise).toEqual(reduce(...events));
  });
});

test("videoActivity finds each video's latest item, downloads by URL and by what they made", () => {
  const view = reduce(
    { type: "item", stage: "download", item: "https://b/BV1", status: "start" },
    {
      type: "item",
      stage: "download",
      item: "https://b/BV1",
      status: "done",
      outputs: ["BV1_p1", "BV1_p2"],
    },
    { type: "item", stage: "transcribe", item: "BV1_p1.m4a", video: "BV1_p1", status: "start" },
  );
  const activity = videoActivity(view);
  expect(activity.get("https://b/BV1")?.status).toBe("done");
  expect(activity.get("BV1_p1")?.stage).toBe("transcribe");
  expect(activity.get("BV1_p2")?.stage).toBe("download");
  expect(activity.has("BV2")).toBe(false);
});

test("latestJob picks the persona's newest job of the commands asked for", () => {
  const job = (id: string, persona: string, command: JobSnapshot["command"], startedAt: string) =>
    ({ id, persona, command, startedAt }) as const;
  const jobs = [
    job("1", "a", "plan", "2026-11-05T10:00:00.000Z"),
    job("2", "a", "plan", "2026-11-05T11:00:00.000Z"),
    job("3", "b", "plan", "2026-11-05T12:00:00.000Z"),
    job("4", "a", "pipeline", "2026-11-05T13:00:00.000Z"),
  ];
  expect(latestJob(jobs, "a", ["plan"])?.id).toBe("2");
  expect(latestJob(jobs, "a", ["plan", "pipeline"])?.id).toBe("4");
  expect(latestJob(jobs, "c", ["plan"])).toBeNull();
});
