// A task's commands, kept across its runs in <task>/bash/: each one's output in <n>.log, and
// runs.json saying how each ended and whether the worker was told. One still running at the yield
// goes on in the background, and the task's runs wait for it and hear how it ended.
import { type FileHandle, mkdir, open, readdir, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { errorText, isPlainObject } from "@eidolon/config";
import type { TaskBackground, TaskToolResult } from "@eidolon/engine";
import { replaceJsonFile } from "../transcript.ts";
import type { PathGuard } from "../types.ts";
import {
  BASH_KILL,
  BASH_OUTPUT,
  type BashOperations,
  createLocalBashOperations,
  MAX_BACKGROUND,
  OUTPUT_CAP_BYTES,
  YIELD_MS,
} from "./bash.ts";
import { type LogTail, readLogTail, sanitize } from "./output.ts";
import { pathExists } from "./path.ts";
import { readLines } from "./read.ts";
import { ABORTED, errorResult } from "./results.ts";
import { shellEnv } from "./shell.ts";
import {
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationOptions,
  type TruncationResult,
} from "./truncate.ts";

const RUNS = "runs.json";
const CLOSED = "Commands can't start now: the task is stopping.";
/** What the call that moves a command to the background shows of its output so far. */
const PEEK: TruncationOptions = { maxLines: 20, maxBytes: 4 * 1024 };
/** How often a call waiting on its command looks for a steering line. */
const POLL_MS = 1000;

/** How a command ended. */
export type BashEnd =
  /** It exited, on its own or killed from outside. */
  | "exit"
  /** It couldn't start. */
  | "failed"
  | "timeout"
  | "output-limit"
  /** It would have moved to the background with MAX_BACKGROUND already there. */
  | "background-full"
  /** bash_kill. */
  | "killed"
  /** Its call was cancelled, or its task ended. */
  | "stopped"
  /** The server stopped. */
  | "shutdown"
  /** The server died while it ran, and it may still be running. */
  | "lost";

/** A command as runs.json keeps it. */
interface BashRun {
  readonly id: number;
  readonly command: string;
  /** ms since the epoch. */
  readonly startedAt: number;
  readonly timeoutMs: number;
  /** Its call returned while it ran. */
  background: boolean;
  endedAt?: number;
  exitCode?: number;
  end?: BashEnd;
  /** The worker knows how it ended: from its call, a notice, bash_output or bash_kill. */
  seen?: boolean;
}

/** A command running in the background, as the task's card lists it. */
export interface BackgroundCommand {
  readonly id: number;
  readonly command: string;
  readonly startedAt: number;
  /** When its timeout kills it, ms since the epoch. */
  readonly endsAt: number;
}

/** A bash call's result's details, for the UI and the transcript; the worker never sees them. */
export interface BashDetails {
  readonly id: number;
  /** The command still ran when its call returned. */
  readonly background: boolean;
  readonly end?: BashEnd;
  readonly exitCode?: number;
  readonly seconds?: number;
  readonly truncation?: Omit<TruncationResult, "content">;
}

export interface BashJobsOptions {
  /** The commands in the background, each time that list changes. */
  readonly onChange?: (background: readonly BackgroundCommand[]) => void;
  /** How commands run: the local shell, unless a test stands in for it. */
  readonly operations?: BashOperations;
  /** A folder of Eidolon's own commands, first on each command's PATH. */
  readonly bin?: string;
  /** Set for each command besides the cut environment. */
  readonly variables?: Readonly<Record<string, string>>;
  /** Tests shorten these. */
  readonly yieldMs?: number;
  readonly outputCapBytes?: number;
  readonly pollMs?: number;
}

export interface BashRunOptions {
  /** The task's folder, where the command starts, and the folders its PATH leaves out. */
  readonly guard: PathGuard;
  /** From its start, time in the background included. */
  readonly timeoutMs: number;
  /** The call stays until the command ends, unless a steering line moves it to the background. */
  readonly wait: boolean;
  /** The call's: while the call waits on the command, an abort kills it. */
  readonly signal: AbortSignal;
  /**
   * Whether a steering line waits for the run: the command then moves to the background, or, with
   * the background full, ends or reaches the yield first.
   */
  readonly steered?: () => boolean;
}

interface Job {
  readonly run: BashRun;
  readonly log: string;
  readonly stop: AbortController;
  /** Resolves once its end is recorded and its log is whole. */
  readonly ended: Promise<void>;
  /** Its process is gone, though its end may not be recorded yet. */
  settled: boolean;
  bytes: number;
  /** What its call says for an end its process didn't choose: why it couldn't start, or why stopped. */
  why?: string;
  /** Stops its call's abort from killing it. */
  unlisten(): void;
}

/** A log's writes, in order, each after the one before. */
class LogWriter {
  readonly #handle: FileHandle;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(handle: FileHandle) {
    this.#handle = handle;
  }

  write(data: Uint8Array): void {
    this.#writes = this.#writes.then(() => this.#handle.write(data)).catch(() => {});
  }

  async close(): Promise<void> {
    await this.#writes;
    await this.#handle.close().catch(() => {});
  }
}

const ENDS: ReadonlySet<unknown> = new Set<BashEnd>([
  "exit",
  "failed",
  "timeout",
  "output-limit",
  "background-full",
  "killed",
  "stopped",
  "shutdown",
  "lost",
]);

const isWhole = (value: unknown): value is number => Number.isInteger(value);
const isTime = (value: unknown): value is number => Number.isFinite(value);

function isRun(value: unknown): value is BashRun {
  return (
    isPlainObject(value) &&
    isWhole(value.id) &&
    value.id > 0 &&
    typeof value.command === "string" &&
    isTime(value.startedAt) &&
    isTime(value.timeoutMs) &&
    typeof value.background === "boolean" &&
    (value.endedAt === undefined || isTime(value.endedAt)) &&
    (value.exitCode === undefined || isWhole(value.exitCode)) &&
    (value.end === undefined || ENDS.has(value.end)) &&
    (value.seen === undefined || typeof value.seen === "boolean")
  );
}

/** runs.json's runs; none when it is missing or isn't version 1, and the logs then keep the ids. */
async function readRuns(path: string): Promise<BashRun[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isPlainObject(value) || value.v !== 1 || !Array.isArray(value.runs)) return [];
    return value.runs.filter(isRun);
  } catch {
    return [];
  }
}

/** `ms` as the worker reads it: tenths under ten seconds. */
function seconds(ms: number): string {
  const s = ms / 1000;
  return `${s < 10 ? Math.round(s * 10) / 10 : Math.round(s)} s`;
}

/** 16MB rather than 16.0MB. */
function size(bytes: number): string {
  return formatSize(bytes).replace(/\.0(?=[KM]B$)/, "");
}

/** pi's: `status` after `text`, a blank line between. */
function appendStatus(text: string, status: string): string {
  return `${text ? `${text}\n\n` : ""}${status}`;
}

/** 1, 2 and 3. */
function listed(ids: readonly number[]): string {
  return ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;
}

/** How the rest of a command's output is read: from bash's result, or from bash_output's own. */
interface Rest {
  /** After a cut tail. */
  readonly lines: string;
  /** After binary output's note. */
  readonly binary: string;
}

function restFrom(id: number): Rest {
  return {
    lines: `${BASH_OUTPUT} with id ${id} and an offset reads the rest.`,
    binary: `${BASH_OUTPUT} with id ${id} and an offset pages it as text`,
  };
}

const REST_HERE: Rest = {
  lines: "An offset reads the rest.",
  binary: "an offset pages it as text",
};

/** What follows a command's output when only its end is shown: pi's notes. */
function truncationNote(tail: LogTail, rest: Rest): string {
  const { truncation } = tail;
  if (!truncation.truncated) return "";
  const endLine = truncation.totalLines;
  const startLine = endLine - truncation.outputLines + 1;
  if (truncation.lastLinePartial) {
    return `\n\n[Showing the last ${formatSize(truncation.outputBytes)} of line ${endLine}, which is ${formatSize(tail.lastLineBytes)}. ${rest.lines}]`;
  }
  const limit =
    truncation.truncatedBy === "lines" ? "" : ` (${formatSize(truncation.maxBytes)} limit)`;
  return `\n\n[Showing lines ${startLine}-${endLine} of ${endLine}${limit}. ${rest.lines}]`;
}

/** The end of a command's output as a result shows it, cleaned; "" when it printed nothing. */
function shownOutput(tail: LogTail, rest: Rest): string {
  if (tail.binary) {
    return `(binary output: ${formatSize(tail.truncation.totalBytes)}, not shown; ${rest.binary})`;
  }
  // A tail cut down to one blank line is empty, and its note still says where the rest is.
  return tail.content === "" && !tail.truncation.truncated
    ? ""
    : sanitize(tail.content) + truncationNote(tail, rest);
}

function details(run: BashRun, tail?: LogTail): BashDetails {
  let truncation: BashDetails["truncation"];
  if (tail?.truncation.truncated) {
    const { content: _, ...cut } = tail.truncation;
    truncation = cut;
  }
  return {
    id: run.id,
    background: run.background,
    ...(run.end === undefined ? {} : { end: run.end }),
    ...(run.exitCode === undefined ? {} : { exitCode: run.exitCode }),
    ...(run.endedAt === undefined ? {} : { seconds: (run.endedAt - run.startedAt) / 1000 }),
    ...(truncation === undefined ? {} : { truncation }),
  };
}

export class BashJobs implements TaskBackground {
  readonly #dir: string;
  readonly #runs: BashRun[];
  readonly #jobs = new Map<number, Job>();
  readonly #onChange: BashJobsOptions["onChange"];
  readonly #operations: BashOperations;
  readonly #bin: string | undefined;
  readonly #variables: Readonly<Record<string, string>>;
  readonly #yieldMs: number;
  readonly #outputCap: number;
  readonly #pollMs: number;
  #lastId: number;
  #saving: Promise<void> = Promise.resolve();
  /** killAll ran: the task ended or the server is stopping, and no command starts. */
  #closed = false;

  private constructor(dir: string, runs: BashRun[], lastId: number, options: BashJobsOptions) {
    this.#dir = dir;
    this.#runs = runs;
    this.#lastId = lastId;
    this.#onChange = options.onChange;
    this.#operations = options.operations ?? createLocalBashOperations();
    this.#bin = options.bin;
    this.#variables = options.variables ?? {};
    this.#yieldMs = options.yieldMs ?? YIELD_MS;
    this.#outputCap = options.outputCapBytes ?? OUTPUT_CAP_BYTES;
    this.#pollMs = options.pollMs ?? POLL_MS;
  }

  /**
   * The registry of the task whose records are in `taskDir`, in its bash/ folder, made 0700 if new.
   * One instance per task at a time. A command its last owner left without an end ran when the
   * server died: it ends `lost`, which the next run hears about if it ran in the background.
   */
  static async open(taskDir: string, options: BashJobsOptions = {}): Promise<BashJobs> {
    const dir = join(taskDir, "bash");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const runs = await readRuns(join(dir, RUNS));
    const logged = (await readdir(dir)).flatMap((name) => {
      const id = /^(\d+)\.log$/.exec(name)?.[1];
      return id === undefined ? [] : [Number(id)];
    });
    const jobs = new BashJobs(
      dir,
      runs,
      Math.max(0, ...runs.map((run) => run.id), ...logged),
      options,
    );
    const lost = runs.filter((run) => run.end === undefined);
    for (const run of lost) {
      run.end = "lost";
      // One in the foreground was its call's, whose interrupted result tells the worker.
      run.seen = !run.background;
    }
    if (lost.length > 0) await jobs.#save();
    return jobs;
  }

  /**
   * Runs `command`, resolving with its call's result: how it ended, or, once it has run for the
   * yield, or a steering line came, that it moved to the background.
   */
  async run(command: string, options: BashRunOptions): Promise<TaskToolResult> {
    const { guard, timeoutMs, wait, signal, steered } = options;
    if (this.#closed) return errorResult(CLOSED);
    if (signal.aborted) return errorResult(ABORTED);
    const id = ++this.#lastId;
    const log = this.#logPath(id);
    const writer = new LogWriter(await open(log, "w", 0o600));
    const run: BashRun = { id, command, startedAt: Date.now(), timeoutMs, background: false };
    this.#runs.push(run);
    const path = [this.#bin, process.env.PATH].filter((entry) => entry !== undefined);
    // The bin folder passes PATH's filter like any other, so one the task could write is dropped.
    const env = {
      ...(await shellEnv(guard, { ...process.env, PATH: path.join(delimiter) })),
      ...this.#variables,
    };
    // Recorded before it starts: a server that dies while it runs leaves it to be found `lost`.
    await this.#save();
    if (this.#closed || signal.aborted) {
      await writer.close();
      run.end = this.#closed ? "shutdown" : "stopped";
      run.endedAt = Date.now();
      run.seen = true;
      await this.#save();
      return errorResult(this.#closed ? CLOSED : ABORTED);
    }

    const stop = new AbortController();
    let recorded!: () => void;
    const cancel = () => stop.abort("stopped" satisfies BashEnd);
    const job: Job = {
      run,
      log,
      stop,
      ended: new Promise((resolve) => {
        recorded = resolve;
      }),
      settled: false,
      bytes: 0,
      unlisten: () => signal.removeEventListener("abort", cancel),
    };
    this.#jobs.set(id, job);
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop.abort("timeout" satisfies BashEnd), timeoutMs);
    const onData = (data: Buffer) => {
      const room = this.#outputCap - job.bytes;
      if (data.length > room) stop.abort("output-limit" satisfies BashEnd);
      if (room <= 0) return;
      const kept = data.length > room ? data.subarray(0, room) : data;
      job.bytes += kept.length;
      writer.write(kept);
    };
    void this.#operations
      .exec(command, guard.folder, { onData, signal: stop.signal, env })
      .then(
        ({ exitCode }) => ({ exitCode }),
        (error: unknown) => ({ error }),
      )
      .then(async (outcome) => {
        clearTimeout(timer);
        job.unlisten();
        job.settled = true;
        // Decided now: a kill asked for once the process is gone doesn't change how it ended.
        const end: BashEnd = stop.signal.aborted
          ? (stop.signal.reason as BashEnd)
          : "error" in outcome
            ? "failed"
            : "exit";
        if (end === "failed" && "error" in outcome) {
          job.why = `Couldn't run the command: ${errorText(outcome.error)}`;
        }
        await writer.close();
        run.end = end;
        run.endedAt = Date.now();
        if ("exitCode" in outcome && outcome.exitCode !== null) run.exitCode = outcome.exitCode;
        run.seen = !run.background || end === "killed" || end === "stopped";
        void this.#save();
        if (run.background) this.#changed();
        recorded();
      });

    let moved = await this.#untilMoved(job, wait, steered);
    // The limit holds at the yield (L1): a steering line that finds the background full costs no
    // run that would have finished. A waited command, which never yields, runs to its end; another
    // waits for its end or the yield.
    if (
      moved === "steered" &&
      !job.settled &&
      !stop.signal.aborted &&
      this.#backgroundIds().length >= MAX_BACKGROUND
    ) {
      moved = wait ? await job.ended.then(() => null) : await this.#untilYield(job);
    }
    // A command stopped as it would move ends here: a closed registry keeps no background.
    if (moved === null || job.settled || stop.signal.aborted) {
      await job.ended;
      return await this.#ended(job);
    }
    const ids = this.#backgroundIds();
    if (ids.length >= MAX_BACKGROUND) {
      job.why =
        `Command ${id} was stopped rather than moved to the background, where ${ids.length} ` +
        `commands already run (ids ${listed(ids)}). Stop one with ${BASH_KILL}, or wait for one ` +
        "to end, before you run it again.";
      stop.abort("background-full" satisfies BashEnd);
      await job.ended;
      return await this.#ended(job);
    }
    job.unlisten();
    run.background = true;
    void this.#save();
    this.#changed();
    return await this.#moved(job, moved);
  }

  /** Resolves when the command ends (null), or when it should move to the background, and why. */
  #untilMoved(
    job: Job,
    wait: boolean,
    steered: (() => boolean) | undefined,
  ): Promise<"yield" | "steered" | null> {
    return new Promise((resolve) => {
      let poll: ReturnType<typeof setInterval> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (why: "yield" | "steered" | null) => {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(why);
      };
      void job.ended.then(() => finish(null));
      if (!wait) timer = setTimeout(() => finish("yield"), this.#yieldMs);
      if (steered !== undefined) {
        poll = setInterval(() => {
          if (steered()) finish("steered");
        }, this.#pollMs);
      }
    });
  }

  /** Resolves when the command ends (null), or at the yield, counted from its start. */
  #untilYield(job: Job): Promise<"steered" | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve("steered"),
        job.run.startedAt + this.#yieldMs - Date.now(),
      );
      void job.ended.then(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /** The result of a call whose command ended while it waited. */
  async #ended(job: Job): Promise<TaskToolResult> {
    const { run } = job;
    if (run.end === "failed") {
      return {
        content: job.why ?? "Couldn't run the command",
        isError: true,
        details: details(run),
      };
    }
    const tail = await readLogTail(job.log);
    const shown = shownOutput(tail, restFrom(run.id));
    /** pi's: an exit shows "(no output)" for nothing, any other end only its status. */
    const result = (status: string | null, empty = ""): TaskToolResult => ({
      content: status === null ? shown || empty : appendStatus(shown || empty, status),
      ...(status === null ? {} : { isError: true }),
      details: details(run, tail),
    });
    switch (run.end) {
      case "exit":
        if (run.exitCode === 0) return result(null, "(no output)");
        return result(
          run.exitCode === undefined
            ? "Command terminated without an exit code"
            : `Command exited with code ${run.exitCode}`,
          "(no output)",
        );
      case "timeout":
        return result(`Command timed out after ${run.timeoutMs / 1000} seconds`);
      case "output-limit":
        return result(
          `Command stopped: its output passed ${size(this.#outputCap)}. Send big output to a ` +
            "file in the task's folder (command > out.log), then read or grep the file.",
        );
      case "background-full":
        return result(job.why ?? "Command stopped: too many commands run in the background");
      case "shutdown":
        return result("Command stopped: Eidolon is stopping");
      default:
        return result("Command aborted");
    }
  }

  /** The result of a call whose command moved to the background. */
  async #moved(job: Job, why: "yield" | "steered"): Promise<TaskToolResult> {
    const { id, timeoutMs } = job.run;
    const shown = shownOutput(await readLogTail(job.log, PEEK), restFrom(id));
    const opening =
      why === "yield"
        ? `Command ${id} is still running after ${seconds(this.#yieldMs)}, so it moved to the background.`
        : `Command ${id} is still running, and a message came in, so it moved to the background.`;
    const sofar =
      shown === "" ? " It has printed nothing so far." : ` Its output so far:\n\n${shown}`;
    return {
      content:
        `${opening}${sofar}\n\nYou're told when it ends, and the task doesn't end before it does. ` +
        `It is killed if it still runs ${seconds(timeoutMs)} after it started. ${BASH_OUTPUT} ` +
        `with id ${id} shows what it prints, and ${BASH_KILL} stops it.`,
      details: details(job.run),
    };
  }

  /** bash_output: command `id`'s state, then its output's end, or its lines from `offset`. */
  async output(id: number, offset?: number, limit?: number): Promise<TaskToolResult> {
    const run = this.#runs.find((each) => each.id === id);
    if (run === undefined) return this.#unknown(id);
    const log = this.#logPath(id);
    const state = this.#state(run);
    let body = "";
    let tail: LogTail | undefined;
    if (!(await pathExists(log))) {
      // Nothing was written before it was lost.
    } else if (offset !== undefined) {
      try {
        body = sanitize((await readLines(Bun.file(log).stream(), offset, limit)).text);
      } catch (error) {
        return { content: `${state}\n\n${errorText(error)}`, isError: true, details: details(run) };
      }
    } else {
      const maxLines = Math.min(limit ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES);
      tail = await readLogTail(log, { maxLines });
      body = shownOutput(tail, REST_HERE);
    }
    if (body === "") body = run.end === undefined ? "(no output yet)" : "(no output)";
    this.#see(run);
    return { content: `${state}\n\n${body}`, details: details(run, tail) };
  }

  /** bash_kill: stops command `id` with its process group, and shows how it ended. */
  async kill(id: number): Promise<TaskToolResult> {
    const job = this.#jobs.get(id);
    if (job !== undefined) {
      if (!job.settled) job.stop.abort("killed" satisfies BashEnd);
      await job.ended;
    }
    return this.output(id);
  }

  /**
   * Kills every command still running and records how each ended, after which none starts:
   * `stopped` when its task ends, `shutdown` when the server stops, which the task's next run hears
   * about for each that ran in the background.
   */
  async killAll(end: "stopped" | "shutdown"): Promise<void> {
    this.#closed = true;
    const live = [...this.#jobs.values()].filter((job) => job.run.end === undefined);
    for (const job of live) if (!job.settled) job.stop.abort(end);
    await Promise.all(live.map((job) => job.ended));
    await this.flush();
  }

  /** Resolves once runs.json holds every change so far. */
  async flush(): Promise<void> {
    await this.#saving;
  }

  running(): boolean {
    return this.#backgroundIds().length > 0;
  }

  takeEnded(): readonly string[] {
    const lines: string[] = [];
    for (const run of this.#runs) {
      if (run.end === undefined || run.seen === true) continue;
      run.seen = true;
      lines.push(this.#notice(run));
    }
    if (lines.length > 0) void this.#save();
    return lines;
  }

  /** The commands running in the background, oldest first. */
  background(): BackgroundCommand[] {
    return this.#runs
      .filter((run) => run.background && run.end === undefined)
      .map(({ id, command, startedAt, timeoutMs }) => ({
        id,
        command,
        startedAt,
        endsAt: startedAt + timeoutMs,
      }));
  }

  /**
   * The registry as the run that `left` stops sees it: once that run is left, nothing runs for it
   * and it takes no ends, so they wait for the next run rather than go to one that stores nothing.
   */
  forRun(left: AbortSignal): TaskBackground {
    return {
      running: () => !left.aborted && this.running(),
      takeEnded: () => (left.aborted ? [] : this.takeEnded()),
    };
  }

  /** Ends are recorded once the log is whole, so a command stays here until its notice is ready. */
  #backgroundIds(): number[] {
    return this.#runs.filter((run) => run.background && run.end === undefined).map((run) => run.id);
  }

  #logPath(id: number): string {
    return join(this.#dir, `${id}.log`);
  }

  #see(run: BashRun): void {
    if (run.end === undefined || run.seen === true) return;
    run.seen = true;
    void this.#save();
  }

  #unknown(id: number): TaskToolResult {
    return errorResult(
      this.#lastId === 0
        ? "This task has run no commands yet."
        : `No command has id ${id}: this task's ids run from 1 to ${this.#lastId}.`,
    );
  }

  /** Where command `run` stands, in a sentence. */
  #state(run: BashRun): string {
    const { id } = run;
    const took = run.endedAt === undefined ? "" : ` after ${seconds(run.endedAt - run.startedAt)}`;
    switch (run.end) {
      case undefined:
        return (
          `Command ${id} is running${run.background ? " in the background" : ""}, for ` +
          `${seconds(Date.now() - run.startedAt)} so far; it is killed at ${seconds(run.timeoutMs)}.`
        );
      case "exit":
        return run.exitCode === undefined
          ? `Command ${id} ended without an exit code${took}.`
          : `Command ${id} ended with code ${run.exitCode}${took}.`;
      case "failed":
        return `Command ${id} couldn't start.`;
      case "timeout":
        return `Command ${id} was killed at its timeout of ${seconds(run.timeoutMs)}.`;
      case "output-limit":
        return `Command ${id} was killed when its output passed ${size(this.#outputCap)}.`;
      case "background-full":
        return `Command ${id} was stopped: ${MAX_BACKGROUND} commands already ran in the background.`;
      case "killed":
        return `Command ${id} was stopped with ${BASH_KILL}${took}.`;
      case "stopped":
        return `Command ${id} was stopped when its task stopped.`;
      case "shutdown":
        return `Command ${id} was stopped when Eidolon stopped.`;
      case "lost":
        return `Eidolon lost track of command ${id} when it stopped without warning; it may still be running.`;
    }
  }

  /** The runtime line telling the worker how command `run` ended: its id and its end, no output. */
  #notice(run: BashRun): string {
    const { id } = run;
    switch (run.end) {
      case "shutdown":
        return `[Command ${id} was stopped when Eidolon stopped; run it again if it's still needed.]`;
      case "lost":
        return `[Eidolon lost track of command ${id} when it stopped without warning; it may still be running and holding its ports.]`;
      default:
        return `[${this.#state(run)} ${BASH_OUTPUT} with id ${id} shows its output.]`;
    }
  }

  #changed(): void {
    this.#onChange?.(this.background());
  }

  /** Writes runs.json after the writes before it, as the runs then stand; never rejects. */
  #save(): Promise<void> {
    this.#saving = this.#saving
      .then(() => replaceJsonFile(join(this.#dir, RUNS), { v: 1, runs: this.#runs }))
      .catch(() => {});
    return this.#saving;
  }
}
