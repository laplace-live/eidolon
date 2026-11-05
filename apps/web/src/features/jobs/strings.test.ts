// The job pages build these keys from values the CLI and the API define, so no literal names them.
import { expect, test } from "bun:test";
import type { ItemStatus, ProgressEvent, Stage } from "@eidolon/ingest/progress";
import { JOB_COMMANDS } from "../../../../bot/src/local/api.ts";
import type { Outcome } from "../../lib/jobs";
import en from "../../locales/en/jobs.json";
import zh from "../../locales/zh-CN/jobs.json";

type StageStatus = Extract<ProgressEvent, { type: "stage" }>["status"];
type CountedUnit = Exclude<
  Extract<ProgressEvent, { type: "progress" }>["unit"],
  "bytes" | "percent"
>;

// Each Record fails to compile when a value is added upstream without a key here.
const STAGES: Record<Stage | "pipeline", null> = {
  setup: null,
  expand: null,
  download: null,
  transcribe: null,
  refine: null,
  "ingest-streams": null,
  "ingest-facts": null,
  catalog: null,
  plan: null,
  pipeline: null,
};
const OUTCOMES: Record<Outcome, null> = {
  running: null,
  succeeded: null,
  failed: null,
  crashed: null,
  cancelled: null,
  interrupted: null,
};
const STAGE_STATUSES: Record<StageStatus, null> = {
  start: null,
  done: null,
  failed: null,
  skipped: null,
  cancelled: null,
};
const ITEM_STATUSES: Record<ItemStatus, null> = {
  start: null,
  done: null,
  skipped: null,
  failed: null,
  cancelled: null,
};
const UNITS: Record<CountedUnit, null> = { chunks: null, rows: null, files: null };

const keys = [
  ...JOB_COMMANDS.map((command) => `command.${command}`),
  ...Object.keys(STAGES).map((stage) => `stage.${stage}`),
  ...Object.keys(OUTCOMES).map((outcome) => `status.${outcome}`),
  ...Object.keys(STAGE_STATUSES).map((status) => `stageStatus.${status}`),
  ...Object.keys(STAGE_STATUSES)
    .filter((status) => status !== "start")
    .map((status) => `log.stage.${status}`),
  ...Object.keys(ITEM_STATUSES).map((status) => `item.${status}`),
  ...Object.keys(UNITS).map((unit) => `progress.${unit}`),
];

test("every command, stage, state and unit a job page names has a string in both languages", () => {
  for (const catalog of [en, zh] as Record<string, string>[]) {
    expect(keys.filter((key) => !(key in catalog))).toEqual([]);
  }
});
