// The local app's tasks, which she starts in a chat with start_task, and may steer or stop there.
// Each runs in this process under its lock, its task.json kept in step with the run; the owner
// answers its approvals from its card, and its end is reported back to the chat. laplace-task's
// tasks have no chat and are never touched: that command may be running one.
import { statSync } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildTaskPrompt,
  COMPACTION_INSTRUCTIONS,
  COMPACTION_SYSTEM,
  createTaskTools,
  type FolderGrant,
  FolderPolicy,
  type FolderPolicyOptions,
  GrantRefused,
  grantRefusal,
  loadContextFiles,
  newTaskId,
  openTaskStore,
  PathRefused,
  readSnapshot,
  TASK_WEB_MODES,
  type TaskChat,
  type TaskInboxLines,
  type TaskPending,
  type TaskSnapshot,
  type TaskStatus,
  type TaskWebAccess,
  type TodoDetails,
  WEB_FETCH,
  webFetchHost,
  writeSnapshot,
} from "@eidolon/assistant";
import {
  type AssistantSettings,
  errorText,
  expandUser,
  findDotenv,
  isPlainObject,
  logger,
  pyStrip,
  shippedPath,
} from "@eidolon/config";
import { acquireLock, LockedError } from "@eidolon/config/lock";
import {
  createMind,
  type Mind,
  type MindToolCall,
  runTask,
  type TaskBrief,
  type TaskEvent,
  type TaskGateDecision,
  type TaskInbox,
  type TaskOutcome,
  type TaskRequest,
  type TaskStore,
  UsageMeter,
} from "@eidolon/engine";
import { accountOf, ProviderConfigError, selectRequired } from "@eidolon/providers";
import {
  type ErrorCode,
  STEER_PREFIX,
  type TaskApproveRequest,
  type TaskContinueRequest,
  type TaskModel,
  type TasksQuery,
} from "../api.ts";
import { readLines } from "../jobs/events.ts";
import { SnapshotFile } from "./snapshot-file.ts";

/** newTaskId's UUIDv7: an id a route may look up. */
export const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** start_task's arguments: OpenClaw's objective, output, write scope and verification. */
export interface TaskBriefInput {
  readonly goal: string;
  /** The goal when absent. */
  readonly deliverable?: string;
  /** Absolute, or under ~. */
  readonly folder: string;
  readonly check?: string;
}

export interface TaskManagerOptions {
  /** The data home: the tasks are in its tasks/, and no task may touch it. */
  readonly dataHome: string;
  /** Assistant Mode's settings as they stand. */
  readonly settings: () => AssistantSettings;
  /** Adds a folder to assistant.folders for good, for an `always` answer. */
  readonly addFolder: (folder: string) => void | Promise<void>;
  /** Why createMind("assistant") would throw now, without sending anything; null when it wouldn't. */
  readonly problem: () => string | null;
  /** Default: the engine's. */
  readonly createMind?: typeof createMind;
  /** ms since the epoch: createdAt, endedAt and the worker's date. Default: Date.now. */
  readonly now?: () => number;
  /**
   * Stores an ended task's `final` in its chat: called at each end, and at boot for each ended task
   * not yet reported. Once it resolves the task is `reported`; a throw is logged, and the next boot
   * calls it again.
   */
  readonly report: (snapshot: TaskSnapshot) => Promise<void>;
  /**
   * Told when a task pauses to wait for the owner, once task.json is written; never at a start, an
   * answer or an end, nor for a pause a cancel has already asked to end. A throw is logged.
   */
  readonly waiting?: (snapshot: TaskSnapshot) => void;
}

type RefusalStatus = 400 | 404 | 409 | 416;

type RefusalCode = Extract<
  ErrorCode,
  | "assistant-off"
  | "assistant-not-ready"
  | "unknown-task"
  | "task-locked"
  | "nothing-pending"
  | "not-paused"
  | "pending"
  | "range-not-satisfiable"
  | "bad-request"
  | "unknown-account"
  | "invalid-path"
  | "conflict"
>;

/**
 * A request the manager turns down: a route answers `status` with `code`, and start_task hands
 * `message` to her, so it is plain English she can retell.
 */
export class TaskRefused extends Error {
  override name = "TaskRefused";
  readonly status: RefusalStatus;
  readonly code: RefusalCode;

  constructor(status: RefusalStatus, code: RefusalCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The holder laplace-task's LockedError names. */
const LOCK_HOLDER = "eidolon";
const TRANSCRIPT = "transcript.jsonl";
const DEFAULT_CHECK = "Check the deliverable against the goal";
const STREAM_CHUNK_BYTES = 256 * 1024;
const STEER_MAX_CHARS = 2000;
const STEP_HEAD_CHARS = 120;
/** What names a call's step, in this order, before the JSON of all its arguments. */
const STEP_KEYS = ["path", "url", "pattern", "glob", "query"] as const;

const LIVE: ReadonlySet<TaskStatus> = new Set([
  "running",
  "paused",
  "awaiting-approval",
  "interrupted",
]);
const ENDED: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled"]);
const ANSWERS: ReadonlySet<unknown> = new Set(["once", "always", "deny"]);
const ASK_EACH_SITE: TaskWebAccess = { mode: "ask", hosts: [], denied: [] };

/** A snapshot's fields to change; one set to undefined is dropped. */
type Changes = { -readonly [K in keyof TaskSnapshot]?: TaskSnapshot[K] };

type Answer = TaskApproveRequest["answer"];

/** What a run needs, made before anything about its task changes. */
interface Equipped {
  readonly mind: Mind;
  readonly meter: UsageMeter;
  /** The task's lock. */
  readonly release: () => void;
}

/** How a model createMind refuses is answered: the role's own, or one the owner picked. */
const NOT_READY: readonly [RefusalStatus, RefusalCode] = [409, "assistant-not-ready"];
const BAD_MODEL: readonly [RefusalStatus, RefusalCode] = [400, "bad-request"];

interface Run extends Omit<Equipped, "mind"> {
  /** The owner's Stop: the loop stores end(cancelled). */
  readonly cancel: AbortController;
  /** The server stopping: the manager stops reading, and nothing more is stored. */
  readonly leave: AbortController;
  settled: Promise<void>;
  /** The site the gate paused for. */
  asked: string | null;
  /** The first path refused in the latest batch. */
  refused: { readonly path: string; readonly access: "read" | "write" } | null;
  /** How the run ended or paused, once its transcript says so. */
  last: TaskOutcome | null;
  /** The calls of the latest reply: stored before the run, or made in it. */
  calls: readonly MindToolCall[];
}

interface Task {
  snapshot: TaskSnapshot;
  readonly dir: string;
  readonly file: SnapshotFile;
  /** The owner's answers and Stop, one at a time. */
  queue: Promise<unknown>;
  run: Run | null;
  /** Kept while the server runs, unless the model changes: a new one forgets an uncounted request. */
  meter: UsageMeter | null;
  /** Wakes each events stream following the task. */
  readonly readers: Set<() => void>;
}

// APFS and NTFS match names in any case.
const fold =
  process.platform === "darwin" || process.platform === "win32"
    ? (path: string) => path.toLowerCase()
    : (path: string) => path;

function isInside(path: string, root: string): boolean {
  const rel = relative(fold(root), fold(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Where `path` lies on disk: its realpath, or its deepest existing folder's plus the rest. */
async function placeOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await placeOf(parent), basename(path));
  }
}

async function insideAny(place: string, folders: readonly string[]): Promise<boolean> {
  for (const folder of folders) if (isInside(place, await placeOf(folder))) return true;
  return false;
}

function withChanges(snapshot: TaskSnapshot, changes: Changes): TaskSnapshot {
  const next: Record<string, unknown> = { ...snapshot, ...changes };
  for (const key of Object.keys(changes)) if (next[key] === undefined) delete next[key];
  return next as unknown as TaskSnapshot;
}

function filled(text: string | undefined): string | null {
  return typeof text === "string" && pyStrip(text) !== "" ? pyStrip(text) : null;
}

/** The brief's folder with ~ expanded; a relative one names no one place, so it is refused. */
function folderOf(text: string): string {
  const given = pyStrip(text);
  if (given === "") throw new TaskRefused(400, "invalid-path", "A task needs a folder");
  const path = expandUser(given);
  if (!isAbsolute(path)) {
    throw new TaskRefused(
      400,
      "invalid-path",
      `${given} isn't a folder's full path: start it with / or ~`,
    );
  }
  return resolve(path);
}

/** The owner's date, as their computer keeps it. */
function today(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const weekday = at.toLocaleDateString("en-US", { weekday: "long" });
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}, ${weekday}`;
}

const webOf = (snapshot: TaskSnapshot): TaskWebAccess => snapshot.web ?? ASK_EACH_SITE;

/** The owner's refusal of a site outlasts a later Any Site. */
function allows(web: TaskWebAccess, host: string): boolean {
  return !web.denied.includes(host) && (web.mode === "any" || web.hosts.includes(host));
}

function adding(list: readonly string[], more: readonly string[] | undefined): readonly string[] {
  return more === undefined || more.every((each) => list.includes(each))
    ? list
    : [...new Set([...list, ...more])];
}

function steering(inbox: TaskInboxLines | undefined, line: string): TaskInboxLines {
  return { steer: [...(inbox?.steer ?? []), line], followUp: inbox?.followUp ?? [] };
}

/** A call's step as the snapshot names it: its path, url, pattern, glob or query, else its JSON. */
function stepHead(args: Readonly<Record<string, unknown>>): string {
  const named = STEP_KEYS.map((key) => args[key]).find((value) => typeof value === "string");
  const head = [...(typeof named === "string" ? named : JSON.stringify(args))];
  return head.length > STEP_HEAD_CHARS
    ? `${head.slice(0, STEP_HEAD_CHARS).join("")}…`
    : head.join("");
}

/** What `outcome` makes of a task whose run just ended; null: the server stopped it. */
function settledChanges(run: Run, outcome: TaskOutcome | null, endedAt: number): Changes {
  if (outcome === null) return { status: "interrupted" };
  if (outcome.status !== "paused") {
    return {
      status: outcome.status,
      outcome,
      endedAt,
      pending: undefined,
      pause: undefined,
      inbox: undefined,
    };
  }
  let pending: TaskPending | undefined;
  if (outcome.reason === "approval") {
    if (run.asked !== null) pending = { kind: "fetch", host: run.asked };
    else if (run.refused !== null) pending = { kind: "path", ...run.refused };
  }
  return { status: "paused", pause: { reason: outcome.reason, detail: outcome.detail }, pending };
}

/** A store that takes nothing once the run is left: what it would store, a later run redoes. */
function untilLeft(store: TaskStore, left: AbortSignal): TaskStore {
  return {
    entries: () => store.entries(),
    append: (draft) =>
      left.aborted ? Promise.reject(new Error("The task was interrupted")) : store.append(draft),
  };
}

/** `store`, keeping on `run` the calls of the last reply it holds: a resume runs them. */
function noting(store: TaskStore, run: Run): TaskStore {
  return {
    entries: async () => {
      const entries = await store.entries();
      const last = entries.findLast((entry) => entry.type === "assistant");
      if (last?.type === "assistant") run.calls = last.calls;
      return entries;
    },
    append: (draft) => store.append(draft),
  };
}

/** Whether `asked`, the question an answer names, is the one the task asks; naming none answers it. */
function asks(pending: TaskPending, asked: unknown): boolean {
  if (asked === undefined) return true;
  if (!isPlainObject(asked) || asked.kind !== pending.kind) return false;
  switch (pending.kind) {
    case "start":
      return true;
    case "path":
      return (
        asked.path === pending.path &&
        asked.access === pending.access &&
        asked.folder === pending.folder
      );
    case "fetch":
      return asked.host === pending.host;
  }
}

function checkAnswer(body: TaskApproveRequest): void {
  const bad = (message: string) => new TaskRefused(400, "bad-request", message);
  if (!isPlainObject(body) || !ANSWERS.has(body.answer)) {
    throw bad("Send {answer: once, always or deny, pending?, model?, web?}");
  }
  if (body.pending !== undefined && !isPlainObject(body.pending)) {
    throw bad("pending is the question answered, as the task's snapshot gives it");
  }
  if (body.web !== undefined && !(TASK_WEB_MODES as readonly unknown[]).includes(body.web)) {
    throw bad("web is ask, any or off");
  }
  const { model } = body;
  if (
    model !== undefined &&
    !(
      isPlainObject(model) &&
      typeof model.account === "string" &&
      typeof model.model === "string" &&
      pyStrip(model.account) !== "" &&
      pyStrip(model.model) !== ""
    )
  ) {
    throw bad("model is {account, model}");
  }
}

export class TaskManager {
  readonly #root: string;
  readonly #dataHome: string;
  readonly #home = homedir();
  readonly #settings: () => AssistantSettings;
  readonly #addFolder: (folder: string) => void | Promise<void>;
  readonly #problem: () => string | null;
  readonly #createMind: typeof createMind;
  readonly #now: () => number;
  readonly #report: (snapshot: TaskSnapshot) => Promise<void>;
  readonly #waiting: ((snapshot: TaskSnapshot) => void) | undefined;
  readonly #tasks = new Map<string, Task>();
  readonly #streams = new Set<() => void>();
  #loaded: Promise<void> | null = null;
  #starts: Promise<unknown> = Promise.resolve();
  #guards: Omit<FolderPolicyOptions, "folder" | "grants"> | null = null;
  #stopped = false;

  constructor(options: TaskManagerOptions) {
    this.#dataHome = options.dataHome;
    this.#root = join(options.dataHome, "tasks");
    this.#settings = options.settings;
    this.#addFolder = options.addFolder;
    this.#problem = options.problem;
    this.#createMind = options.createMind ?? createMind;
    this.#now = options.now ?? Date.now;
    this.#report = options.report;
    this.#waiting = options.waiting;
  }

  /**
   * The server's start: loads the app's tasks, resumes each interrupted one while Assistant Mode is
   * on and ready, and, in the background, reports each ended one its chat doesn't have yet.
   */
  async boot(): Promise<void> {
    await this.#load();
    if (this.ready()) {
      for (const task of this.#oldestFirst()) {
        if (task.snapshot.status !== "interrupted") continue;
        try {
          await this.#exclusive(task, () => this.#resume(task, {}));
        } catch (error) {
          logger.warning(`Task ${task.snapshot.id} stays interrupted: ${errorText(error)}`);
        }
      }
    }
    const unreported = this.#oldestFirst().filter(
      ({ snapshot }) => ENDED.has(snapshot.status) && snapshot.reported !== true,
    );
    void (async () => {
      for (const task of unreported) if (!this.#stopped) await this.#reportEnd(task);
    })();
  }

  /** The server's stop: every run is left, interrupted, for the next start to resume. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const close of [...this.#streams]) close();
    for (const task of this.#tasks.values()) task.run?.leave.abort();
    await this.#starts;
    const tasks = [...this.#tasks.values()];
    await Promise.all(tasks.map((task) => task.queue));
    // A run launched meanwhile was left as it launched.
    await Promise.all(tasks.map((task) => task.run?.settled));
    await Promise.all(tasks.map((task) => task.file.flush()));
  }

  /** Assistant Mode is on, and a task's mind can be made. */
  ready(): boolean {
    return this.#settings().enabled && this.#problem() === null;
  }

  /** The app's tasks whose status is `running`. */
  running(): number {
    let count = 0;
    for (const { snapshot } of this.#tasks.values()) if (snapshot.status === "running") count++;
    return count;
  }

  /** The app's tasks, or one chat's, newest first. */
  async list(query: TasksQuery = {}): Promise<TaskSnapshot[]> {
    await this.#load();
    return [...this.#tasks.values()]
      .map((task) => task.snapshot)
      .filter((snapshot) => query.chat === undefined || snapshot.chat?.id === query.chat)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  /**
   * Chat `chatId`'s tasks as they stand, oldest first, for a caller that can't wait: none before
   * the first load.
   */
  snapshotsOf(chatId: string): readonly TaskSnapshot[] {
    return this.#oldestFirst().flatMap(({ snapshot }) =>
      snapshot.chat?.id === chatId ? [snapshot] : [],
    );
  }

  async get(id: string): Promise<TaskSnapshot> {
    await this.#load();
    return this.#find(id).snapshot;
  }

  /**
   * The task's transcript.jsonl from byte `after`, whole lines only, then each line stored while it
   * runs; the stream ends once it stops running.
   */
  async events(id: string, after: number): Promise<ReadableStream<Uint8Array>> {
    await this.#load();
    const task = this.#find(id);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TaskRefused(400, "bad-request", "`after` is a byte offset into the transcript");
    }
    const size = await stat(join(task.dir, TRANSCRIPT)).then(
      (found) => found.size,
      () => 0,
    );
    if (after > size) {
      throw new TaskRefused(416, "range-not-satisfiable", "`after` is past the transcript's end");
    }
    return this.#stream(task, after);
  }

  /**
   * Her start_task. Inside assistant.folders the task runs at once; anywhere else it waits for the
   * owner's OK at its start.
   */
  async start(input: TaskBriefInput, origin: TaskChat): Promise<TaskSnapshot> {
    await this.#load();
    // One at a time, so two starts can't both find a folder free.
    const started = this.#starts.then(() => this.#start(input, origin));
    this.#starts = started.catch(() => {});
    return started;
  }

  /** The owner's answer to what the task waits on. */
  async approve(id: string, body: TaskApproveRequest): Promise<TaskSnapshot> {
    await this.#load();
    const task = this.#find(id);
    return this.#exclusive(task, async () => {
      checkAnswer(body);
      const { pending } = task.snapshot;
      if (pending === undefined || task.run !== null) {
        throw new TaskRefused(409, "nothing-pending", "The task isn't waiting for an answer");
      }
      if (!asks(pending, body.pending)) {
        throw new TaskRefused(409, "nothing-pending", "The task asks something else now");
      }
      // A Deny at the start only ends the task, as Stop would, so it works with the mode off.
      if (pending.kind === "start" && body.answer === "deny") {
        return this.#end(task, { denied: true });
      }
      this.#requireMode();
      if (pending.kind === "start") return this.#allowStart(task, body);
      return this.#answerPause(task, pending, body.answer);
    });
  }

  /** Runs a task paused with nothing to answer, or interrupted, again. */
  async continue(id: string, body: TaskContinueRequest = {}): Promise<TaskSnapshot> {
    await this.#load();
    const task = this.#find(id);
    return this.#exclusive(task, async () => {
      const step = isPlainObject(body) ? body.spendPauseUsd : null;
      if (step !== undefined && !(typeof step === "number" && Number.isFinite(step) && step >= 0)) {
        throw new TaskRefused(400, "bad-request", "spendPauseUsd is an amount of 0 or more");
      }
      const { status, pending, pause } = task.snapshot;
      if (pending !== undefined) {
        throw new TaskRefused(409, "pending", "The task waits for an answer: give it first");
      }
      if (task.run !== null || (status !== "paused" && status !== "interrupted")) {
        throw new TaskRefused(409, "not-paused", "The task isn't paused");
      }
      this.#requireMode();
      // A meter that can't price a request can't count toward a pause either.
      const spendPauseUsd =
        pause?.reason === "unpriced" ? 0 : (step ?? task.snapshot.spendPauseUsd);
      return this.#resume(task, { spendPauseUsd });
    });
  }

  /**
   * Her steer_task: `text`, stripped, joins the task's inbox in task.json at once as her line, for
   * its run to read before its next request, or as it goes on after an Allow, an answer or Continue.
   * It answers, allows and continues nothing; a Deny at its start or a Stop drops it with the
   * inbox.
   */
  async steer(id: string, text: string): Promise<TaskSnapshot> {
    await this.#load();
    const task = this.#find(id);
    return this.#exclusive(task, async () => {
      const line = pyStrip(text);
      if (line === "") throw new TaskRefused(400, "bad-request", "There is no text to pass on.");
      if ([...line].length > STEER_MAX_CHARS) {
        throw new TaskRefused(400, "bad-request", "The text to pass on is over 2,000 characters.");
      }
      const { status, inbox } = task.snapshot;
      if (!LIVE.has(status)) {
        throw new TaskRefused(409, "conflict", `The task has ended (${status})`);
      }
      await this.#change(task, { inbox: steering(inbox, `${STEER_PREFIX}${line}`) }, true);
      return task.snapshot;
    });
  }

  /** The card's Stop: a live task ends cancelled, an ended one comes back as it is. */
  async cancel(id: string): Promise<TaskSnapshot> {
    await this.#load();
    const task = this.#find(id);
    const run = await this.#exclusive(task, async () => {
      if (!LIVE.has(task.snapshot.status)) return null;
      if (task.run === null) {
        await this.#end(task, {});
        return null;
      }
      task.run.cancel.abort();
      return task.run;
    });
    await run?.settled;
    // A run past its last check for the cancel stores its pause anyway, leaving the task live.
    if (run !== null && LIVE.has(task.snapshot.status)) return this.cancel(id);
    return task.snapshot;
  }

  /** Stops every live task of a chat, which is being deleted. */
  async cancelChat(chatId: string): Promise<void> {
    await this.#load();
    await this.#cancelWhere((snapshot) => snapshot.chat?.id === chatId);
  }

  /** The settings route's word that assistant.enabled was written: off stops every live task. */
  async modeChanged(enabled: boolean): Promise<void> {
    if (enabled) return;
    await this.#load();
    // A start past its check of the mode is tracked only once made; any later one is refused.
    await this.#starts;
    await this.#cancelWhere(() => true);
  }

  #load(): Promise<void> {
    this.#loaded ??= this.#readAll();
    return this.#loaded;
  }

  async #readAll(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.#root);
    } catch {
      return;
    }
    for (const name of names.filter((each) => TASK_ID.test(each))) {
      const dir = join(this.#root, name);
      try {
        const snapshot = await readSnapshot(dir);
        if (snapshot?.chat === undefined) continue;
        if (snapshot.id !== name) throw new Error(`its task.json is task ${snapshot.id}'s`);
        const task = this.#track(dir, snapshot);
        if (snapshot.status === "running") await this.#crashed(task);
      } catch (error) {
        logger.warning(`Skipping task ${name}: ${errorText(error)}`);
      }
    }
  }

  #track(dir: string, snapshot: TaskSnapshot): Task {
    const task: Task = {
      snapshot,
      dir,
      file: new SnapshotFile(dir, snapshot),
      queue: Promise.resolve(),
      run: null,
      meter: null,
      readers: new Set(),
    };
    this.#tasks.set(snapshot.id, task);
    return task;
  }

  /** A task task.json calls running, at load: a crash left it so, unless laplace-task runs it. */
  async #crashed(task: Task): Promise<void> {
    let release: () => void;
    try {
      release = acquireLock(`task:${task.snapshot.id}`, LOCK_HOLDER);
    } catch (error) {
      if (error instanceof LockedError) return;
      throw error;
    }
    try {
      await this.#change(task, { status: "interrupted" }, true);
    } finally {
      release();
    }
  }

  #oldestFirst(): Task[] {
    return [...this.#tasks.values()].sort(
      (a, b) =>
        a.snapshot.createdAt - b.snapshot.createdAt || a.snapshot.id.localeCompare(b.snapshot.id),
    );
  }

  #find(id: string): Task {
    const task = this.#tasks.get(id);
    if (task === undefined) throw new TaskRefused(404, "unknown-task", "No task has that id");
    return task;
  }

  #exclusive<T>(task: Task, work: () => Promise<T>): Promise<T> {
    const result = task.queue.then(work, work);
    task.queue = result.catch(() => {});
    return result;
  }

  /** Changes the snapshot and writes it: `now`, or within a second while a run streams. */
  #change(task: Task, changes: Changes, now = false): Promise<void> {
    task.snapshot = withChanges(task.snapshot, changes);
    return task.file.save(task.snapshot, !now);
  }

  #requireMode(): void {
    if (!this.#settings().enabled) {
      throw new TaskRefused(409, "assistant-off", "Assistant Mode is off");
    }
    const problem = this.#problem();
    if (problem !== null) throw new TaskRefused(409, "assistant-not-ready", problem);
  }

  /** What every task's policy keeps it from: this app, its data, the owner's keys. */
  #policy(folder: string, grants: readonly FolderGrant[]): FolderPolicy {
    this.#guards ??= {
      home: this.#home,
      dataHome: this.#dataHome,
      // EIDOLON_APP_ROOT's package, or this checkout.
      appRoot: shippedPath(".", "."),
      // The one load-env.ts reads: from a worktree, its main checkout's.
      dotenv: findDotenv(import.meta.dir),
    };
    return new FolderPolicy({ folder, grants, ...this.#guards });
  }

  /** A run's grants: assistant.folders as they stand now, then the task's own. */
  #grants(own: readonly FolderGrant[]): FolderGrant[] {
    return [
      ...this.#settings().folders.map((path): FolderGrant => ({ path, access: "read-write" })),
      ...own,
    ];
  }

  /**
   * What task `id`'s run needs, made before anything about the task changes: its mind on `model`,
   * billed through `meter`, and its lock. A model createMind refuses is answered with `refusal`.
   */
  #equip(id: string, model: TaskModel, meter: UsageMeter, refusal = NOT_READY): Equipped {
    let mind: Mind;
    try {
      mind = this.#createMind("assistant", { ...model, tap: meter.tap });
    } catch (error) {
      if (error instanceof ProviderConfigError) {
        throw new TaskRefused(refusal[0], refusal[1], error.message);
      }
      throw error;
    }
    return { mind, meter, release: this.#lock(id) };
  }

  #lock(id: string): () => void {
    try {
      return acquireLock(`task:${id}`, LOCK_HOLDER);
    } catch (error) {
      if (error instanceof LockedError) throw new TaskRefused(409, "task-locked", error.message);
      throw error;
    }
  }

  /** The meter a run on `model` bills through: the task's own while its model stays. */
  #meter(task: Task, model: TaskModel): UsageMeter {
    const { account, model: current } = task.snapshot.model;
    if (task.meter !== null && model.account === account && model.model === current) {
      return task.meter;
    }
    return new UsageMeter({ ...model, spentUsd: task.snapshot.spentUsd });
  }

  async #start(input: TaskBriefInput, origin: TaskChat): Promise<TaskSnapshot> {
    this.#requireMode();
    const settings = this.#settings();
    const goal = pyStrip(input.goal);
    if (goal === "") throw new TaskRefused(400, "bad-request", "A task needs a goal");
    const brief: TaskBrief = {
      goal,
      deliverable: filled(input.deliverable) ?? goal,
      folder: folderOf(input.folder),
      check: filled(input.check) ?? DEFAULT_CHECK,
    };
    let place: string;
    try {
      const policy = this.#policy(brief.folder, this.#grants([]));
      place = await policy.resolve(brief.folder, "write");
      // Always would add a file to assistant.folders, for every task to write unasked.
      const found = await stat(place).catch((error: unknown) => {
        if ((error as { code?: unknown }).code === "ENOENT") return null;
        throw error;
      });
      if (found !== null && !found.isDirectory()) throw new Error("it is a file");
    } catch (error) {
      if (error instanceof GrantRefused || error instanceof PathRefused) {
        throw new TaskRefused(400, "invalid-path", error.message);
      }
      throw new TaskRefused(
        400,
        "invalid-path",
        `${brief.folder} can't be a task's folder: ${errorText(error)}`,
      );
    }
    for (const { snapshot } of this.#tasks.values()) {
      if (!LIVE.has(snapshot.status)) continue;
      const there = await placeOf(snapshot.brief.folder);
      // Two tasks writing one folder undo each other's edits.
      if (isInside(place, there) || isInside(there, place)) {
        throw new TaskRefused(
          409,
          "conflict",
          `A task is already working in ${snapshot.brief.folder}: ${snapshot.brief.goal}.`,
        );
      }
    }
    const runs = await insideAny(place, settings.folders);
    let model: TaskModel;
    try {
      const selection = selectRequired("assistant");
      model = { account: selection.account.id, model: selection.model };
    } catch (error) {
      if (error instanceof ProviderConfigError) {
        throw new TaskRefused(409, "assistant-not-ready", error.message);
      }
      throw error;
    }
    const id = newTaskId();
    const dir = join(this.#root, id);
    const snapshot: TaskSnapshot = {
      v: 1,
      id,
      createdAt: this.#now(),
      status: runs ? "running" : "awaiting-approval",
      chat: origin,
      brief,
      model,
      grants: [],
      spendPauseUsd: settings.spendPauseUsd,
      spentUsd: 0,
      files: { read: [], written: [] },
      web: ASK_EACH_SITE,
      ...(runs ? {} : { pending: { kind: "start" } }),
    };
    const equipped = runs ? this.#equip(id, model, new UsageMeter(model)) : null;
    try {
      await openTaskStore(dir).append({ type: "brief", brief });
      await writeSnapshot(dir, snapshot);
    } catch (error) {
      equipped?.release();
      throw error;
    }
    const task = this.#track(dir, snapshot);
    if (equipped !== null) this.#launch(task, equipped);
    return task.snapshot;
  }

  async #allowStart(task: Task, body: TaskApproveRequest): Promise<TaskSnapshot> {
    const { id } = task.snapshot;
    const chosen =
      body.model === undefined
        ? null
        : { account: pyStrip(body.model.account).toLowerCase(), model: pyStrip(body.model.model) };
    if (chosen !== null && accountOf(chosen.account) === undefined) {
      throw new TaskRefused(400, "unknown-account", "Eidolon has no such account");
    }
    const model = chosen ?? task.snapshot.model;
    const refusal = chosen === null ? NOT_READY : BAD_MODEL;
    const equipped = this.#equip(id, model, this.#meter(task, model), refusal);
    try {
      if (body.answer === "always") await this.#addFolder(task.snapshot.brief.folder);
    } catch (error) {
      equipped.release();
      throw error;
    }
    const web = body.web === undefined ? {} : { web: { ...webOf(task.snapshot), mode: body.web } };
    return this.#run(task, equipped, { model, ...web });
  }

  async #answerPause(
    task: Task,
    pending: Exclude<TaskPending, { readonly kind: "start" }>,
    answer: Answer,
  ): Promise<TaskSnapshot> {
    const { id, model } = task.snapshot;
    const equipped = this.#equip(id, model, this.#meter(task, model));
    try {
      const changes =
        pending.kind === "path"
          ? await this.#answerPath(task, pending, answer)
          : this.#answerSite(task, pending.host, answer);
      return await this.#run(task, equipped, changes);
    } catch (error) {
      equipped.release();
      throw error;
    }
  }

  /**
   * A refused path's answer: a grant of what its question named, its folder or else the path alone,
   * with the access asked for, and a line telling the worker.
   */
  async #answerPath(
    task: Task,
    pending: Extract<TaskPending, { readonly kind: "path" }>,
    answer: Answer,
  ): Promise<Changes> {
    const { path, access, folder } = pending;
    const tell = (line: string): Changes => ({ inbox: steering(task.snapshot.inbox, line) });
    if (answer === "deny") return tell(`The owner refused access to ${path}.`);
    // Every task may read and write assistant.folders: only a write's folder joins them, never a file.
    if (answer === "always" && access === "write" && folder !== undefined) {
      await this.#addFolder(folder);
    }
    const grant: FolderGrant = {
      path: folder ?? path,
      access: access === "write" ? "read-write" : "read",
    };
    const { grants } = task.snapshot;
    const known = grants.some((each) => each.path === grant.path && each.access === grant.access);
    return {
      grants: known ? grants : [...grants, grant],
      ...tell(`The owner allowed ${grant.access} access to ${grant.path}. Try again.`),
    };
  }

  /**
   * The folder an Allow of `path` grants: the path, else its parent, whichever is a folder on disk;
   * undefined, and the path alone granted, when neither is or that folder can't be granted, as home
   * can't. A grant holds its own path, so a folder not made yet could be written as a file.
   */
  #folderFor(path: string): string | undefined {
    const folder = [path, dirname(path)].find((each) => {
      try {
        return statSync(each).isDirectory();
      } catch {
        return false;
      }
    });
    return folder !== undefined && grantRefusal(folder, this.#home) === null ? folder : undefined;
  }

  #answerSite(task: Task, host: string, answer: Answer): Changes {
    const web = webOf(task.snapshot);
    const add = (list: readonly string[]) => (list.includes(host) ? list : [...list, host]);
    switch (answer) {
      case "once":
        return { web: { ...web, hosts: add(web.hosts) } };
      case "always":
        return { web: { ...web, mode: "any" } };
      case "deny":
        return { web: { ...web, denied: add(web.denied) } };
    }
  }

  async #resume(task: Task, changes: Changes): Promise<TaskSnapshot> {
    const { id, model } = task.snapshot;
    return this.#run(task, this.#equip(id, model, this.#meter(task, model)), changes);
  }

  async #run(task: Task, equipped: Equipped, changes: Changes): Promise<TaskSnapshot> {
    await this.#change(
      task,
      { ...changes, status: "running", pending: undefined, pause: undefined },
      true,
    );
    this.#launch(task, equipped);
    return task.snapshot;
  }

  /** Ends a task no run of this server holds as cancelled: Stop, or a Deny at its start. */
  async #end(task: Task, changes: Changes): Promise<TaskSnapshot> {
    const release = this.#lock(task.snapshot.id);
    try {
      const outcome: TaskOutcome = { status: "cancelled" };
      // Stop works on a damaged transcript too: task.json is what says the task is over.
      await openTaskStore(task.dir)
        .append({ type: "end", outcome })
        .catch((error: unknown) => {
          logger.warning(`Task ${task.snapshot.id}'s end wasn't stored: ${errorText(error)}`);
        });
      await this.#change(
        task,
        {
          ...changes,
          status: "cancelled",
          outcome,
          endedAt: this.#now(),
          pending: undefined,
          pause: undefined,
          inbox: undefined,
        },
        true,
      );
    } finally {
      release();
    }
    void this.#reportEnd(task);
    return task.snapshot;
  }

  async #cancelWhere(which: (snapshot: TaskSnapshot) => boolean): Promise<void> {
    const live = [...this.#tasks.values()].filter(
      ({ snapshot }) => LIVE.has(snapshot.status) && which(snapshot),
    );
    await Promise.all(
      live.map(async ({ snapshot }) => {
        try {
          await this.cancel(snapshot.id);
        } catch (error) {
          logger.warning(`Task ${snapshot.id} wasn't stopped: ${errorText(error)}`);
        }
      }),
    );
  }

  #launch(task: Task, { mind, meter, release }: Equipped): void {
    const run: Run = {
      cancel: new AbortController(),
      leave: new AbortController(),
      meter,
      release,
      settled: Promise.resolve(),
      asked: null,
      refused: null,
      last: null,
      calls: [],
    };
    task.meter = meter;
    task.run = run;
    if (this.#stopped) run.leave.abort();
    run.settled = this.#follow(task, run, mind);
  }

  async #follow(task: Task, run: Run, mind: Mind): Promise<void> {
    let outcome: TaskOutcome | null = null;
    try {
      const request = await this.#request(task, run, mind);
      if (!run.leave.signal.aborted) outcome = await this.#read(task, run, runTask(request));
    } catch (error) {
      if (!run.leave.signal.aborted) {
        outcome = { status: "failed", error: errorText(error) };
        await openTaskStore(task.dir)
          .append({ type: "end", outcome })
          .catch(() => {});
      }
    }
    await this.#settle(task, run, outcome ?? run.last);
  }

  async #request(task: Task, run: Run, mind: Mind): Promise<TaskRequest> {
    const { id, brief, grants, spendPauseUsd } = task.snapshot;
    const policy = this.#policy(brief.folder, this.#grants(grants));
    await mkdir(await policy.resolve(brief.folder, "write"), { recursive: true });
    // Asked at each call and redirect, so an approval reaches the tools without making them again.
    const site = { allows: (host: string) => allows(webOf(task.snapshot), host) };
    const tools = createTaskTools(policy, webOf(task.snapshot).mode === "off" ? {} : { web: site });
    const contextFiles = await loadContextFiles(brief.folder, this.#home, policy);
    const left = run.leave.signal;
    return {
      id,
      // So a request in flight stops with the server, rather than at its next chunk.
      mind: {
        stream: (request) =>
          mind.stream({ ...request, signal: AbortSignal.any([request.signal, left]) }),
      },
      system: buildTaskPrompt({
        brief,
        tools,
        contextFiles,
        date: today(new Date(this.#now())),
        folder: brief.folder,
      }),
      tools,
      store: untilLeft(noting(openTaskStore(task.dir), run), left),
      inbox: this.#inbox(task, run),
      meter: run.meter,
      gate: async (call) => this.#gate(task, run, call),
      limits: { contextTokens: this.#settings().contextTokens, spendPauseUsd },
      compaction: { system: COMPACTION_SYSTEM, instructions: COMPACTION_INSTRUCTIONS },
      pauseOnRefused: true,
      signal: run.cancel.signal,
    };
  }

  /** web_fetch asks the owner for each site the task may not reach yet, before the call starts. */
  #gate(task: Task, run: Run, call: MindToolCall): TaskGateDecision {
    if (call.name !== WEB_FETCH) return null;
    // Null: the tool refuses the call whatever the owner says.
    const host = webFetchHost(call.arguments);
    if (host === null) return null;
    const web = webOf(task.snapshot);
    if (web.denied.includes(host)) return { block: `The owner refused fetching from ${host}.` };
    if (allows(web, host)) return null;
    run.asked = host;
    return { pause: `fetch from ${host}` };
  }

  /**
   * The run's inbox over task.json's: a line the run takes is gone from it at once. A run that was
   * left takes none, as its store would refuse the line's entry.
   */
  #inbox(task: Task, run: Run): TaskInbox {
    const take = (kind: keyof TaskInboxLines, all: boolean): readonly string[] => {
      const { inbox } = task.snapshot;
      if (run.leave.signal.aborted || inbox === undefined || inbox[kind].length === 0) return [];
      const taken = all ? inbox[kind] : inbox[kind].slice(0, 1);
      const rest = { ...inbox, [kind]: inbox[kind].slice(taken.length) };
      const empty = rest.steer.length === 0 && rest.followUp.length === 0;
      void this.#change(task, { inbox: empty ? undefined : rest }, true);
      return taken;
    };
    return {
      hasSteering: () => !run.leave.signal.aborted && (task.snapshot.inbox?.steer.length ?? 0) > 0,
      takeSteering: (all) => take("steer", all),
      takeFollowUps: (all) => take("followUp", all),
    };
  }

  /** Reads the run's events until it ends; null once the server stops reading it. */
  async #read(
    task: Task,
    run: Run,
    reader: AsyncGenerator<TaskEvent, TaskOutcome>,
  ): Promise<TaskOutcome | null> {
    const left = new Promise<null>((resolve) => {
      run.leave.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    let done = false;
    try {
      for (;;) {
        const next = await Promise.race([reader.next(), left]);
        if (next === null) return null;
        if (next.done) {
          done = true;
          return next.value;
        }
        this.#onEvent(task, run, next.value);
      }
    } finally {
      // runTask stops at its next event once its reader leaves; its store already takes nothing.
      if (!done) void reader.return({ status: "cancelled" }).catch(() => {});
    }
  }

  #onEvent(task: Task, run: Run, event: TaskEvent): void {
    const spentUsd = run.meter.spentUsd();
    if (event.type === "request" && event.state === "end") {
      void this.#change(task, { spentUsd });
      return;
    }
    if (event.type !== "entry") return;
    const { entry } = event;
    const changes: Changes = { spentUsd };
    if (entry.type === "assistant") {
      run.refused = null;
      run.calls = entry.calls;
    }
    if (entry.type === "tool-start") {
      const made = run.calls.find((each) => each.id === entry.callId);
      changes.step = { tool: entry.name, head: made === undefined ? "" : stepHead(made.arguments) };
    }
    if (entry.type === "tool-result") {
      const { files } = task.snapshot;
      changes.files = {
        read: adding(files.read, entry.files?.read),
        written: adding(files.written, entry.files?.written),
      };
      if (entry.refused !== undefined) run.refused ??= entry.refused;
      if (entry.name === "todo" && !entry.isError && entry.details !== undefined) {
        changes.todo = (entry.details as TodoDetails).items;
      }
    }
    if (entry.type === "pause") {
      run.last = { status: "paused", reason: entry.reason, detail: entry.detail };
    }
    if (entry.type === "end") run.last = entry.outcome;
    void this.#change(task, changes);
    for (const wake of task.readers) wake();
  }

  async #settle(task: Task, run: Run, outcome: TaskOutcome | null): Promise<void> {
    const changes = settledChanges(run, outcome, this.#now());
    const { pending } = changes;
    if (pending?.kind === "path") {
      const folder = this.#folderFor(pending.path);
      if (folder !== undefined) changes.pending = { ...pending, folder };
    }
    // Released first: an answer the new status lets in may start the next run at once. Nothing may
    // await from here to the write: a Stop that ended the task in between would be undone by it.
    run.release();
    task.run = null;
    const written = this.#change(task, changes, true);
    for (const wake of task.readers) wake();
    await written;
    if (outcome === null) return;
    if (outcome.status !== "paused") void this.#reportEnd(task);
    // A cancel that came as the run decided to pause ends the task next: nothing waits on the owner.
    else if (!run.cancel.signal.aborted) this.#tellWaiting(task);
  }

  #tellWaiting(task: Task): void {
    try {
      this.#waiting?.(task.snapshot);
    } catch (error) {
      logger.exception(`Task ${task.snapshot.id}'s pause wasn't told to its chat`, error);
    }
  }

  async #reportEnd(task: Task): Promise<void> {
    try {
      await this.#report(task.snapshot);
    } catch (error) {
      logger.exception(
        `Task ${task.snapshot.id}'s end didn't reach its chat; the next start reports it again`,
        error,
      );
      return;
    }
    if (!this.#stopped) await this.#change(task, { reported: true }, true);
  }

  #stream(task: Task, after: number): ReadableStream<Uint8Array> {
    const path = join(task.dir, TRANSCRIPT);
    let offset = after;
    let open = true;
    let wake: (() => void) | null = null;
    const nudge = (): void => wake?.();
    const close = (): void => {
      open = false;
      nudge();
      task.readers.delete(nudge);
      this.#streams.delete(close);
    };
    task.readers.add(nudge);
    this.#streams.add(close);
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (open) {
          // Before the read: a run that ends in between still has its last lines read.
          const running = task.run !== null;
          const chunk = readLines(path, offset, STREAM_CHUNK_BYTES);
          if (chunk.length > 0) {
            offset += chunk.length;
            controller.enqueue(chunk);
            return;
          }
          if (!running) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
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
}
