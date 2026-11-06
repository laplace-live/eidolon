// The jobs this server runs: the CLI as detached children whose stdout and stderr go straight to
// files the server tails, so a job outlives a reloaded page and the server's own restart.
import { closeSync } from "node:fs";
import { uptime } from "node:os";
import { jobArgv } from "@eidolon/cli/job";
import { dataHome, errorText, logger } from "@eidolon/config";
import type { Subprocess } from "bun";
import type { JobSnapshot } from "../api.ts";
import { EPHEMERAL_COMMANDS, type JobSpec } from "./argv.ts";
import { endedStatus, JobEvents, readLines, tailOf } from "./events.ts";
import {
  createOutputs,
  jobFiles,
  lastWrite,
  loadRecords,
  mintJobId,
  removeJob,
  type StopReason,
  type StoredJob,
  writeRecord,
} from "./store.ts";

/** The argv that runs a CLI command; tests run a fake CLI. */
export type ArgvBuilder = (command: string, args: readonly string[]) => string[];

export interface JobRunnerOptions {
  readonly argv?: ArgvBuilder;
  /** How often an open events stream, and a job an earlier server started, are checked. */
  readonly pollMs?: number;
  /** Jobs kept, besides plans and previews. */
  readonly keep?: number;
}

/** A job the runner knows: its record, its events so far, and its process while it's this one's. */
export interface Job {
  record: StoredJob;
  readonly events: JobEvents;
  child: Subprocess | null;
  /** Running, started by an earlier server: watched until it ends, never signalled. */
  adopted: boolean;
  /** The stderr tail of an ended job, set once its files are read to their end. */
  tail: string | null;
  readonly ended: Promise<void>;
  readonly markEnded: () => void;
}

export type CancelOutcome = "stopping" | "ended" | "not-ours";

/** How long stopping the server waits for its jobs to exit, so their records say how they ended. */
const STOP_WAIT_MS = 2000;
const STREAM_CHUNK_BYTES = 256 * 1024;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process: it exists.
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function newestFirst(a: Job, b: Job): number {
  const at = b.record.startedAt.localeCompare(a.record.startedAt);
  return at !== 0 ? at : b.record.id.localeCompare(a.record.id);
}

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly endListeners: ((job: Job) => void)[] = [];
  private readonly streams = new Set<() => void>();
  private readonly argv: ArgvBuilder;
  private readonly pollMs: number;
  private readonly keep: number;
  private watcher: ReturnType<typeof setInterval> | null = null;

  /**
   * Loads the jobs on disk: a plan or preview is dropped, and a running one is checked on. One
   * started before this machine booted is gone, whatever process its pid names now.
   */
  constructor(options: JobRunnerOptions = {}) {
    this.argv = options.argv ?? jobArgv;
    this.pollMs = options.pollMs ?? 250;
    this.keep = options.keep ?? 50;
    const bootedAt = Date.now() - uptime() * 1000;
    for (const record of loadRecords()) {
      if (record.ephemeral) {
        removeJob(record.id);
        continue;
      }
      const job = this.track(record);
      if (record.status !== "running") {
        job.markEnded();
        continue;
      }
      job.events.advance(jobFiles(record.id).events);
      if (
        job.events.final === null &&
        record.pid !== null &&
        Date.parse(record.startedAt) >= bootedAt &&
        alive(record.pid)
      ) {
        job.adopted = true;
      } else {
        this.end(job, null, true, lastWrite(record.id) ?? new Date());
      }
    }
    this.prune(null);
    this.watchAdopted();
  }

  /** Calls `listener` whenever a job ends. */
  onEnd(listener: (job: Job) => void): void {
    this.endListeners.push(listener);
  }

  find(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Open events streams. */
  get streaming(): number {
    return this.streams.size;
  }

  /** Spawns `spec`'s CLI command line as a new job; `resumedFrom` names the job it reruns. */
  start(spec: JobSpec, resumedFrom: string | null = null): Job {
    const at = new Date();
    const id = mintJobId(at);
    const files = jobFiles(id);
    const record: StoredJob = {
      id,
      command: spec.command,
      persona: spec.persona,
      options: spec.options,
      status: "running",
      startedAt: at.toISOString(),
      endedAt: null,
      exitCode: null,
      ephemeral: EPHEMERAL_COMMANDS.has(spec.command),
      resumedFrom,
      resumedBy: null,
      pid: null,
      stopReason: null,
    };
    const outputs = createOutputs(files);
    let child: Subprocess;
    try {
      // Before the spawn: a server that dies right after it still finds the job at its next start.
      writeRecord(record);
      // No env: the CLI applies the .env itself. Passing what this process applied from it would
      // keep a key deleted from the .env since.
      child = Bun.spawn(this.argv(spec.cli, spec.args), {
        cwd: dataHome(),
        stdin: "ignore",
        stdout: outputs.events,
        stderr: outputs.log,
        // Its own process group: Ctrl-C in the terminal reaches only the server, which stops its
        // jobs itself, and a kill of the group reaches the CLI's own children too.
        detached: true,
      });
    } catch (error) {
      removeJob(id);
      throw error;
    } finally {
      closeSync(outputs.events);
      closeSync(outputs.log);
    }
    const job = this.track({ ...record, pid: child.pid });
    job.child = child;
    void child.exited
      .then((code) => this.end(job, code, false))
      .catch((error: unknown) => logger.exception(`Job ${id} could not be recorded`, error));
    logger.info(`Job ${id} started: ${spec.command} for ${spec.persona} (pid ${child.pid})`);
    writeRecord(job.record);
    if (resumedFrom !== null) {
      const old = this.jobs.get(resumedFrom);
      if (old !== undefined) {
        old.record = { ...old.record, resumedBy: id };
        writeRecord(old.record);
      }
    }
    this.prune(job);
    return job;
  }

  /** Every job, newest first. */
  list(): JobSnapshot[] {
    return [...this.jobs.values()].sort(newestFirst).map((job) => this.snapshot(job));
  }

  snapshot(job: Job): JobSnapshot {
    let tail = job.tail;
    // An ended job's files no longer change: read once more after its end, then kept.
    if (tail === null) {
      const files = jobFiles(job.record.id);
      job.events.advance(files.events);
      tail = tailOf(files.log);
      if (job.record.status !== "running") job.tail = tail;
    }
    const { pid: _pid, stopReason, ...record } = job.record;
    return {
      ...record,
      stages: job.events.stageList(),
      costUsd: job.events.costUsd(),
      failures: job.events.failures(),
      stderrTail: tail,
      eventsSize: job.events.offset,
      summarySeen: job.events.final !== null,
      stopping: record.status === "running" && stopReason !== null,
      signalable: job.child !== null,
    };
  }

  /**
   * Asks this server's running job to stop with SIGTERM, which the CLI answers by cancelling its
   * run once any index rebuild it is in has finished. Asked again with `force`, it kills the
   * job's whole process group, which can leave an index half rebuilt.
   */
  cancel(job: Job, force = false): CancelOutcome {
    if (job.record.status !== "running") return "ended";
    const child = job.child;
    if (child === null) return "not-ours";
    if (job.record.stopReason === null) {
      this.signalStop(job, "cancel");
    } else if (force) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is gone.
      }
    }
    // Otherwise nothing: a second SIGTERM makes the CLI quit at once, even mid-rebuild.
    return "stopping";
  }

  /**
   * The job's events from byte `after` as they are written, whole lines only, until the job ends
   * or the client goes away.
   */
  eventsStream(job: Job, after: number): ReadableStream<Uint8Array> {
    const path = jobFiles(job.record.id).events;
    let offset = after;
    let open = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const close = (): void => {
      open = false;
      clearTimeout(timer);
      wake?.();
      this.streams.delete(close);
    };
    this.streams.add(close);
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (open) {
          // Checked before the read: a job that ends in between still has its last lines read.
          const running = job.record.status === "running";
          const chunk = readLines(path, offset, STREAM_CHUNK_BYTES);
          if (chunk.length > 0) {
            offset += chunk.length;
            controller.enqueue(chunk);
            return;
          }
          if (!running) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, this.pollMs);
          });
        }
        close();
        try {
          controller.close();
        } catch {
          // The client cancelled it.
        }
      },
      cancel: close,
    });
  }

  /**
   * The stop hook: ends the streams and sends SIGTERM to every job this server runs, then waits
   * briefly so the quick ones record how they ended. Nothing is killed: a job still finishing an
   * index rebuild runs on in its own process group, and the next server watches it to its end.
   */
  async stop(): Promise<void> {
    if (this.watcher !== null) clearInterval(this.watcher);
    this.watcher = null;
    for (const close of [...this.streams]) close();
    const running = [...this.jobs.values()].filter((job) => job.child !== null);
    for (const job of running) {
      if (job.record.stopReason === null) this.signalStop(job, "shutdown");
    }
    if (running.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(running.map((job) => job.ended)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Saves why `job` stops, then sends it SIGTERM: a server that dies in between still knows. */
  private signalStop(job: Job, reason: StopReason): void {
    job.record = { ...job.record, stopReason: reason };
    try {
      writeRecord(job.record);
    } catch (error) {
      logger.error(`Job ${job.record.id}'s stop wasn't saved`, error);
    }
    job.child?.kill("SIGTERM");
  }

  private track(record: StoredJob): Job {
    let markEnded = (): void => {};
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    const job: Job = {
      record,
      events: new JobEvents(record.command),
      child: null,
      adopted: false,
      tail: null,
      ended,
      markEnded,
    };
    this.jobs.set(record.id, job);
    return job;
  }

  /** Records how `job` ended; `unseen` when no server saw its process exit. */
  private end(job: Job, exitCode: number | null, unseen: boolean, at = new Date()): void {
    if (job.record.status !== "running") return;
    job.child = null;
    job.adopted = false;
    job.events.advance(jobFiles(job.record.id).events);
    const status = endedStatus(job.events.final, job.record.stopReason, unseen);
    job.record = { ...job.record, status, endedAt: at.toISOString(), exitCode };
    if (this.jobs.get(job.record.id) === job) {
      try {
        writeRecord(job.record);
      } catch (error) {
        logger.error(`Job ${job.record.id} ended ${status}, but its record wasn't saved`, error);
      }
    }
    job.markEnded();
    const code = exitCode === null ? "" : ` (exit ${exitCode})`;
    logger.info(`Job ${job.record.id} ${status}${code}`);
    for (const listener of this.endListeners) listener(job);
  }

  /** Checks on the jobs an earlier server left running until each ends. */
  private watchAdopted(): void {
    if (![...this.jobs.values()].some((job) => job.adopted)) return;
    this.watcher = setInterval(() => {
      let watching = false;
      for (const job of this.jobs.values()) {
        if (!job.adopted) continue;
        try {
          job.events.advance(jobFiles(job.record.id).events);
        } catch (error) {
          logger.warning(`Job ${job.record.id}'s events can't be read: ${errorText(error)}`);
        }
        const pid = job.record.pid;
        if (job.events.final !== null || pid === null || !alive(pid)) this.end(job, null, true);
        else watching = true;
      }
      if (!watching && this.watcher !== null) {
        clearInterval(this.watcher);
        this.watcher = null;
      }
    }, this.pollMs);
    this.watcher.unref();
  }

  private drop(job: Job): void {
    this.jobs.delete(job.record.id);
    removeJob(job.record.id);
  }

  /**
   * Keeps the newest `keep` jobs that aren't plans or previews, and of those only the newest per
   * command and persona; a running job always stays.
   */
  private prune(fresh: Job | null): void {
    if (fresh?.record.ephemeral) {
      for (const job of this.jobs.values()) {
        const same =
          job.record.ephemeral &&
          job.record.command === fresh.record.command &&
          job.record.persona === fresh.record.persona;
        if (job !== fresh && same && job.record.status !== "running") this.drop(job);
      }
    }
    const kept = [...this.jobs.values()].filter((job) => !job.record.ephemeral).sort(newestFirst);
    for (const job of kept.slice(this.keep)) {
      if (job.record.status !== "running") this.drop(job);
    }
  }
}
