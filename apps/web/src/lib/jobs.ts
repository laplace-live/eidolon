// A job's events, as its NDJSON file holds them, reduced to what the job page and the studio show.
// Pure: replaying the file from offset 0 gives the view the live stream built.
import type {
  EventCode,
  ItemStatus,
  PlanVideo,
  PlaylistEntry,
  ProgressEvent,
  Provider,
  Stage,
} from "@eidolon/ingest/progress";
import type { JobCommand, JobRecord, JobSnapshot } from "./api";

/** One line of a job's events file: the event, its schema version `v` and its time `t` in ms. */
export type JobEvent = ProgressEvent & { readonly v?: number; readonly t?: number };

type StageEvent = Extract<ProgressEvent, { type: "stage" }>;
type ItemEvent = Extract<ProgressEvent, { type: "item" }>;
type ProgressUpdate = Extract<ProgressEvent, { type: "progress" }>;
export type SummaryEvent = Extract<ProgressEvent, { type: "summary" }>;
/** The events the log shows: progress and plan rows have views of their own. */
export type LoggedEvent = Exclude<ProgressEvent, ProgressUpdate | { type: "plan" }>;

/** The newest log lines a view keeps; a long run's earlier ones are only counted. */
export const LOG_LIMIT = 500;

export interface Progress {
  readonly done: number;
  readonly total: number | null;
  readonly unit: ProgressUpdate["unit"];
}

export interface StageView {
  readonly stage: Stage;
  readonly status: StageEvent["status"];
  /** The items it goes through, once it said. */
  readonly total: number | null;
  /** Items it has reported on. */
  readonly items: number;
  /** Items that ended each way. */
  readonly done: number;
  readonly skipped: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly message: string | null;
  readonly code: EventCode | null;
  readonly provider: Provider | null;
  /** Progress the stage reports as a whole, such as rows embedded. */
  readonly progress: Progress | null;
}

export interface ItemView {
  readonly stage: Stage;
  readonly item: string;
  /** The yt-dlp id, which is the audio's stem. */
  readonly video: string | null;
  readonly status: ItemStatus;
  readonly index: number | null;
  readonly total: number | null;
  readonly message: string | null;
  readonly code: EventCode | null;
  readonly provider: Provider | null;
  readonly costUsd: number | null;
  /** The video ids a download created. */
  readonly outputs: readonly string[];
  readonly progress: Progress | null;
}

export interface LogLine {
  /** When the CLI wrote it; null for a line without `t`. */
  readonly t: number | null;
  readonly event: LoggedEvent;
}

export interface JobView {
  /** In the order they first reported. */
  readonly stages: readonly StageView[];
  readonly items: readonly ItemView[];
  readonly entries: readonly PlaylistEntry[];
  /** One row per video id, in plan order. */
  readonly plan: readonly PlanVideo[];
  readonly summaries: readonly SummaryEvent[];
  readonly log: readonly LogLine[];
  /** Log lines dropped to stay at LOG_LIMIT. */
  readonly logDropped: number;
  /** Where each item and plan row sits, by itemKey and by video id. */
  readonly itemAt: ReadonlyMap<string, number>;
  readonly planAt: ReadonlyMap<string, number>;
}

export const EMPTY_JOB_VIEW: JobView = {
  stages: [],
  items: [],
  entries: [],
  plan: [],
  summaries: [],
  log: [],
  logDropped: 0,
  itemAt: new Map(),
  planAt: new Map(),
};

type Draft = {
  -readonly [K in keyof JobView]: JobView[K] extends ReadonlyMap<infer Key, infer Value>
    ? Map<Key, Value>
    : JobView[K] extends readonly (infer Element)[]
      ? Element[]
      : JobView[K];
};

const ENDED = ["done", "skipped", "failed", "cancelled"] as const;
type Ended = (typeof ENDED)[number];

function ended(status: ItemStatus): status is Ended {
  return (ENDED as readonly string[]).includes(status);
}

export function itemKey(stage: Stage, item: string): string {
  return `${stage}\u0000${item}`;
}

function stageAt(view: Draft, stage: Stage): number {
  const at = view.stages.findIndex((entry) => entry.stage === stage);
  if (at !== -1) return at;
  view.stages.push({
    stage,
    status: "start",
    total: null,
    items: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    message: null,
    code: null,
    provider: null,
    progress: null,
  });
  return view.stages.length - 1;
}

function applyStage(view: Draft, event: StageEvent): void {
  const at = stageAt(view, event.stage);
  const stage = view.stages[at] as StageView;
  view.stages[at] = {
    ...stage,
    status: event.status,
    total: event.total ?? stage.total,
    message: event.message ?? null,
    code: event.code ?? null,
    provider: event.provider ?? null,
  };
}

function applyItem(view: Draft, event: ItemEvent): void {
  const key = itemKey(event.stage, event.item);
  const at = view.itemAt.get(key);
  const before = at === undefined ? null : (view.items[at] as ItemView);
  const item: ItemView = {
    stage: event.stage,
    item: event.item,
    video: event.video ?? before?.video ?? null,
    status: event.status,
    index: event.index ?? before?.index ?? null,
    total: event.total ?? before?.total ?? null,
    message: event.message ?? null,
    code: event.code ?? null,
    provider: event.provider ?? null,
    costUsd: event.costUsd ?? before?.costUsd ?? null,
    outputs: event.outputs ?? before?.outputs ?? [],
    progress: before?.progress ?? null,
  };
  if (at === undefined) {
    view.itemAt.set(key, view.items.length);
    view.items.push(item);
  } else {
    view.items[at] = item;
  }

  // An item counts once, under the way it ended last.
  const s = stageAt(view, event.stage);
  const stage = view.stages[s] as StageView;
  const counts: Record<Ended, number> = {
    done: stage.done,
    skipped: stage.skipped,
    failed: stage.failed,
    cancelled: stage.cancelled,
  };
  if (before !== null && ended(before.status)) counts[before.status] -= 1;
  if (ended(item.status)) counts[item.status] += 1;
  view.stages[s] = {
    ...stage,
    ...counts,
    items: stage.items + (before === null ? 1 : 0),
    total: stage.total ?? item.total,
  };
}

function applyProgress(view: Draft, event: ProgressUpdate): void {
  const progress: Progress = { done: event.done, total: event.total ?? null, unit: event.unit };
  const at =
    event.item === undefined ? undefined : view.itemAt.get(itemKey(event.stage, event.item));
  if (at !== undefined) {
    view.items[at] = { ...(view.items[at] as ItemView), progress };
    return;
  }
  // Progress for no item, or for one that reports no item events (yt-dlp's own download).
  const s = stageAt(view, event.stage);
  view.stages[s] = { ...(view.stages[s] as StageView), progress };
}

function applyPlan(view: Draft, video: PlanVideo): void {
  const at = view.planAt.get(video.id);
  if (at === undefined) {
    view.planAt.set(video.id, view.plan.length);
    view.plan.push(video);
  } else {
    view.plan[at] = video;
  }
}

function apply(view: Draft, event: JobEvent): void {
  switch (event.type) {
    case "stage":
      applyStage(view, event);
      break;
    case "item":
      applyItem(view, event);
      break;
    case "progress":
      applyProgress(view, event);
      return;
    case "entry":
      view.entries.push(event.entry);
      break;
    case "plan":
      applyPlan(view, event.video);
      return;
    case "summary":
      view.summaries.push(event);
      break;
    default:
      // A type a newer CLI writes: nothing here knows how to show it.
      return;
  }
  view.log.push({ t: event.t ?? null, event });
}

/** `view` with `events` applied in order; `view` itself is left as it was. */
export function reduceJob(view: JobView, events: readonly JobEvent[]): JobView {
  if (events.length === 0) return view;
  const draft: Draft = {
    stages: [...view.stages],
    items: [...view.items],
    entries: [...view.entries],
    plan: [...view.plan],
    summaries: [...view.summaries],
    log: [...view.log],
    logDropped: view.logDropped,
    itemAt: new Map(view.itemAt),
    planAt: new Map(view.planAt),
  };
  for (const event of events) apply(draft, event);
  const excess = draft.log.length - LOG_LIMIT;
  if (excess > 0) {
    draft.log.splice(0, excess);
    draft.logDropped += excess;
  }
  return draft;
}

/** The summary that closes the run: the pipeline's and the plan's are last of several. */
export function runSummary(view: JobView, command: JobCommand): SummaryEvent | null {
  const stage = command === "pipeline" ? "pipeline" : command === "plan" ? "plan" : null;
  for (let at = view.summaries.length - 1; at >= 0; at--) {
    const summary = view.summaries[at] as SummaryEvent;
    if (stage === null || summary.stage === stage) return summary;
  }
  return null;
}

export type Outcome = "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "crashed";

/**
 * How a job ended, by its snapshot, whose status the server reads from the run's summary. A run
 * that failed without writing one died before its end (`crashed`), and only its stderr says why.
 */
export function jobOutcome(job: Pick<JobSnapshot, "status" | "summarySeen">): Outcome {
  return job.status === "failed" && !job.summarySeen ? "crashed" : job.status;
}

/**
 * A job's state as a page shows it. One that ends while shown stays running until its events are
 * read to the end (`viewEnded`), so the view then shows how it ended; one that had ended before
 * it was shown has no end to wait for while its events replay.
 */
export function shownOutcome(
  job: Pick<JobSnapshot, "status" | "summarySeen">,
  viewEnded: boolean,
  endedWhenShown: boolean,
): Outcome {
  if (job.status === "running" || (!viewEnded && !endedWhenShown)) return "running";
  return jobOutcome(job);
}

/**
 * The stage to show for the run as a whole: the latest still running, since one stage can open
 * inside another (yt-dlp's setup inside a download), else the last to open.
 */
export function currentStage(view: JobView): StageView | null {
  for (let at = view.stages.length - 1; at >= 0; at--) {
    const stage = view.stages[at] as StageView;
    if (stage.status === "start") return stage;
  }
  return view.stages.at(-1) ?? null;
}

/**
 * How far a stage is, from 0 to 1; null when it can't tell. Its items count until they have all
 * ended; then, or for a stage without items, the progress it reports as a whole, such as an
 * ingest's embedding after it has read its files.
 */
export function stageFraction(stage: StageView): number | null {
  const finished = stage.done + stage.skipped + stage.failed + stage.cancelled;
  const total = stage.total ?? 0;
  if (stage.items > 0 && total > 0 && finished < total) return finished / total;
  const progress = stage.progress;
  if (progress?.total) return Math.min(1, progress.done / progress.total);
  if (progress?.unit === "percent") return Math.min(1, progress.done / 100);
  if (stage.items > 0 && total > 0) return 1;
  return stage.status === "done" ? 1 : null;
}

/** What the items reported spending so far; null before any did. */
export function costSoFar(view: JobView): number | null {
  let total: number | null = null;
  for (const item of view.items) {
    if (item.costUsd !== null) total = (total ?? 0) + item.costUsd;
  }
  return total;
}

/** Items that failed, in the order they did. */
export function failedItems(view: JobView): ItemView[] {
  return view.items.filter((item) => item.status === "failed");
}

/** Items still in flight. */
export function runningItems(view: JobView): ItemView[] {
  return view.items.filter((item) => item.status === "start");
}

/**
 * Each video's latest item, for a table of videos: by `video`, and for a download, which names
 * its URL, by that URL and by the ids it created.
 */
export function videoActivity(view: JobView): Map<string, ItemView> {
  const latest = new Map<string, ItemView>();
  for (const item of view.items) {
    if (item.video !== null) latest.set(item.video, item);
    if (item.stage === "download") {
      latest.set(item.item, item);
      for (const id of item.outputs) latest.set(id, item);
    }
  }
  return latest;
}

/**
 * The jobs this server runs, oldest first: what a restart interrupts. A job an earlier server
 * started is left out; a restart doesn't signal it, and the next server picks it up again.
 */
export function runningJobs<J extends Pick<JobSnapshot, "status" | "startedAt" | "signalable">>(
  jobs: readonly J[],
): J[] {
  return jobs
    .filter((job) => job.status === "running" && job.signalable)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** The persona's job of one of `commands` that started last. */
export function latestJob<J extends Pick<JobRecord, "persona" | "command" | "startedAt">>(
  jobs: readonly J[],
  persona: string,
  commands: readonly JobCommand[],
): J | null {
  let latest: J | null = null;
  for (const job of jobs) {
    if (job.persona !== persona || !commands.includes(job.command)) continue;
    if (latest === null || Date.parse(job.startedAt) > Date.parse(latest.startedAt)) latest = job;
  }
  return latest;
}
