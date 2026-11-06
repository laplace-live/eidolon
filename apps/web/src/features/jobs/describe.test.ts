import { expect, test } from "bun:test";
import type { Vars } from "@/lib/i18n";
import { describeEvent, reasonText } from "./describe";

// Keys and their values, so a test reads which string a line is built from.
const t = (key: string, vars?: Vars) => (vars ? `${key}${JSON.stringify(vars)}` : key);

test("a code becomes its string, naming the provider it is about", () => {
  expect(reasonText(t, null)).toBeNull();
  expect(reasonText(t, "disk-full")).toBe("events.disk-full");
  expect(reasonText(t, "auth-failed", "soniox")).toBe(
    'jobs.reason.provider{"provider":"events.provider.soniox","reason":"events.auth-failed"}',
  );
});

test("a stage line says how many it goes through, and why it failed", () => {
  const start = describeEvent(t, "en", {
    type: "stage",
    stage: "download",
    status: "start",
    total: 3,
  });
  expect(start).toEqual({
    text: 'jobs.log.stageStartTotal{"stage":"jobs.stage.download","total":3}',
    detail: null,
    tone: "info",
  });
  const failed = describeEvent(t, "en", {
    type: "stage",
    stage: "refine",
    status: "failed",
    code: "insufficient-credits",
    message: "HTTP 402",
  });
  expect(failed.text).toBe(
    'jobs.log.stage.failed{"stage":"jobs.stage.refine"} · events.insufficient-credits',
  );
  expect([failed.detail, failed.tone]).toEqual(["HTTP 402", "error"]);
});

test("an item line carries its place, its reason, and the CLI's English only as detail", () => {
  const line = describeEvent(t, "en", {
    type: "item",
    stage: "transcribe",
    item: "a.m4a",
    status: "done",
    index: 2,
    total: 5,
    code: "no-speech",
    message: "no speech",
    costUsd: 0.5,
  });
  expect(line).toEqual({
    text: "[2/5] a.m4a: jobs.item.done · events.no-speech",
    detail: "no speech · $0.50",
    tone: "ok",
  });
});

test("a summary says how the run ended and lists its failures", () => {
  const line = describeEvent(t, "en", {
    type: "summary",
    stage: "pipeline",
    ok: false,
    counts: {},
    durationSec: 65,
    failures: [{ item: "transcribe", error: "2 files failed" }],
  });
  expect(line).toEqual({
    text: 'jobs.log.summary.failed{"stage":"jobs.stage.pipeline","duration":"1:05"}',
    detail: "transcribe: 2 files failed",
    tone: "error",
  });
});
