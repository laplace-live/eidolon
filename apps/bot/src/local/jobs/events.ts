// A job's events file, the CLI's stdout, read as it grows: whole lines only, so a reader never
// sees half an event, reduced to what a snapshot reports.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isPlainObject } from "@eidolon/config";
import type { ProgressEvent } from "@eidolon/ingest/progress";
import type { JobCommand, JobFailure, JobStage, JobStatus } from "../api.ts";

const EMPTY = Buffer.alloc(0);

/**
 * The whole lines of `path` from byte `offset`, up to about `limit` bytes but at least one line
 * when one is complete; empty when there is none yet, or no file.
 */
export function readLines(path: string, offset: number, limit = Number.POSITIVE_INFINITY): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return EMPTY;
    throw error;
  }
  try {
    const size = fstatSync(fd).size;
    let want = Math.min(size - offset, limit);
    while (want > 0) {
      const buffer = Buffer.alloc(want);
      const read = readSync(fd, buffer, 0, want, offset);
      const end = buffer.subarray(0, read).lastIndexOf(0x0a);
      if (end !== -1) return buffer.subarray(0, end + 1);
      if (read < want || offset + read >= size) return EMPTY;
      want = Math.min(size - offset, want * 2);
    }
    return EMPTY;
  } finally {
    closeSync(fd);
  }
}

const TAIL_BYTES = 16 * 1024;
const TAIL_LINES = 40;

/** The last lines of the text file at `path`; empty when there is none. */
export function tailOf(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, read).toString("utf8");
    // Reading from the middle of the file cuts its first line.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

type Summary = Extract<ProgressEvent, { type: "summary" }>;

/** The summary each command's run ends with; a run without it died before its end. */
const RUN_SUMMARY: Readonly<Record<JobCommand, string>> = {
  pipeline: "pipeline",
  plan: "plan",
  download: "download",
  expand: "expand",
  transcribe: "transcribe",
  refine: "refine",
  "ingest-streams": "ingest-streams",
  "ingest-facts": "ingest-facts",
  "build-stream-catalog": "catalog",
};

/** Failures a snapshot lists; each stage counts the rest. */
const FAILURE_LIMIT = 100;

/** Read this much of a file at a time. */
const CHUNK_BYTES = 1024 * 1024;

type Counted = "done" | "failed" | "skipped";

type StageState = { -readonly [K in keyof JobStage]: JobStage[K] };

interface StageCost {
  items: number | null;
  /** The stage's summary's cost, which replaces its items' once it arrives. */
  summary: number | null;
}

/** One job's events, reduced as they arrive: feed it the file again and it reads only what's new. */
export class JobEvents {
  /** Bytes read so far, always at the end of a line. */
  offset = 0;
  /** The summary that ended the run; null until it arrives. */
  final: Summary | null = null;
  /** Failed items, while their last end was a failure, and failed stages. */
  private readonly failed = new Map<string, JobFailure>();
  private readonly stages = new Map<string, StageState>();
  private readonly costs = new Map<string, StageCost>();
  /** Every item seen, by stage and name, with how it last ended. */
  private readonly items = new Map<string, Counted | null>();
  private readonly command: JobCommand;

  constructor(command: JobCommand) {
    this.command = command;
  }

  /** Reads the lines `path` gained since the last call. */
  advance(path: string): void {
    for (;;) {
      const chunk = readLines(path, this.offset, CHUNK_BYTES);
      if (chunk.length === 0) return;
      this.offset += chunk.length;
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line !== "") this.apply(line);
      }
    }
  }

  stageList(): JobStage[] {
    return [...this.stages.values()].map((stage) => ({ ...stage }));
  }

  /** The first FAILURE_LIMIT failures, in the order they happened. */
  failures(): JobFailure[] {
    return [...this.failed.values()].slice(0, FAILURE_LIMIT);
  }

  /** The run's summary's cost, else each stage's summary's or items' cost; null when none says. */
  costUsd(): number | null {
    if (typeof this.final?.costUsd === "number") return this.final.costUsd;
    let total: number | null = null;
    for (const cost of this.costs.values()) {
      const usd = cost.summary ?? cost.items;
      if (usd !== null) total = (total ?? 0) + usd;
    }
    return total;
  }

  private stage(name: string): StageState {
    let stage = this.stages.get(name);
    if (stage === undefined) {
      stage = {
        stage: name,
        status: "start",
        done: 0,
        failed: 0,
        skipped: 0,
        total: null,
        progress: null,
      };
      this.stages.set(name, stage);
    }
    return stage;
  }

  private cost(name: string): StageCost {
    let cost = this.costs.get(name);
    if (cost === undefined) {
      cost = { items: null, summary: null };
      this.costs.set(name, cost);
    }
    return cost;
  }

  private fail(key: string, event: Extract<ProgressEvent, { type: "stage" | "item" }>): void {
    this.failed.set(key, {
      stage: event.stage,
      item: event.type === "item" ? event.item : null,
      video: (event.type === "item" ? event.video : undefined) ?? null,
      code: event.code ?? null,
      provider: event.provider ?? null,
      message: event.message ?? null,
    });
  }

  private apply(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isPlainObject(parsed)) return;
    const event = parsed as ProgressEvent;
    switch (event.type) {
      case "stage": {
        const stage = this.stage(event.stage);
        stage.status = event.status;
        if (event.total !== undefined) stage.total = event.total;
        if (event.status === "failed") this.fail(event.stage, event);
        return;
      }
      case "item": {
        const stage = this.stage(event.stage);
        if (stage.total === null && event.total !== undefined) stage.total = event.total;
        const key = `${event.stage}\u0000${event.item}`;
        const before = this.items.get(key) ?? null;
        const now: Counted | null =
          event.status === "done" || event.status === "failed" || event.status === "skipped"
            ? event.status
            : before;
        // An item that ends twice, as a retried download does, counts once, as it ended last.
        if (now !== before) {
          if (before !== null) stage[before]--;
          if (now !== null) stage[now]++;
        }
        this.items.set(key, now);
        if (typeof event.costUsd === "number") {
          const cost = this.cost(event.stage);
          cost.items = (cost.items ?? 0) + event.costUsd;
        }
        if (event.status === "failed") this.fail(key, event);
        else if (event.status === "done" || event.status === "skipped") this.failed.delete(key);
        return;
      }
      case "progress": {
        // An item's own progress, such as a download's bytes, belongs to the item's view.
        if (event.item !== undefined && this.items.has(`${event.stage}\u0000${event.item}`)) return;
        this.stage(event.stage).progress = {
          done: event.done,
          total: event.total ?? null,
          unit: event.unit,
        };
        return;
      }
      case "summary": {
        if (typeof event.costUsd === "number" && this.stages.has(event.stage)) {
          this.cost(event.stage).summary = event.costUsd;
        }
        if (event.stage === RUN_SUMMARY[this.command]) this.final = event;
        return;
      }
      default:
        return;
    }
  }
}

/**
 * How a job ended: by its run's summary when it wrote one; else cancelled when it was told to
 * stop, interrupted when it ended while no server watched, and failed when it died on its own.
 */
export function endedStatus(final: Summary | null, stopping: boolean, unseen: boolean): JobStatus {
  if (final !== null) {
    if (final.ok) return "succeeded";
    return final.cancelled || stopping ? "cancelled" : "failed";
  }
  if (unseen) return "interrupted";
  return stopping ? "cancelled" : "failed";
}
