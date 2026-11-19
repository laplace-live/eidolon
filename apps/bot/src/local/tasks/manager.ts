// The local app's tasks, which she starts in a chat with start_task, and may steer or stop there.
// Each runs in this process under its lock, its task.json kept in step with the run; the owner
// answers its approvals from its card, or its chat's permission level lets them through, and its
// end is reported back to the chat. laplace-task's tasks have no chat and are never touched: that
// command may be running one.
import { statSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  BASH,
  BashJobs,
  type BashJobsOptions,
  bashCommand,
  bashOffered,
  bashTimeoutSeconds,
  buildTaskPrompt,
  COMPACTION_INSTRUCTIONS,
  COMPACTION_SYSTEM,
  catalogOf,
  createTaskTools,
  type FolderGrant,
  FolderPolicy,
  type FolderPolicyOptions,
  GrantRefused,
  grantRefusal,
  isEnded,
  isInside,
  isLive,
  isTaskId,
  loadContextFiles,
  loadSkills,
  MCP_TOOL_PREFIX,
  type McpArgument,
  type McpFailure,
  type McpLeftOut,
  McpSession,
  type McpToolRef,
  mcpArgumentList,
  mcpCallKey,
  mcpStanding,
  newTaskId,
  openTaskStore,
  type PathGuard,
  PathRefused,
  parseReview,
  REVIEW_SYSTEM,
  type ReviewedAction,
  type ReviewReason,
  type ReviewVerdict,
  readMcpConfig,
  readMcpSecrets,
  readSnapshot,
  reviewable,
  reviewPrompt,
  type SkillCatalog,
  scanSkills,
  skillNames,
  sliceHead,
  TASK_WEB_MODES,
  type TaskChat,
  type TaskInboxLines,
  type TaskPending,
  type TaskProfile,
  type TaskSkills,
  type TaskSnapshot,
  type TaskWebAccess,
  type TodoDetails,
  taskDate,
  taskLockKey,
  taskSkills,
  tasksDir,
  transcriptPath,
  WEB_FETCH,
  WEB_SEARCH,
  type WebSearcher,
  webFetchHost,
  writeSnapshot,
} from "@eidolon/assistant";
import type { PermissionLevel } from "@eidolon/chat";
import {
  type AssistantSettings,
  errorText,
  expandUser,
  findDotenv,
  isPlainObject,
  logger,
  pyStrip,
  raceAbort,
  sharedSkillsDir,
  shippedPath,
} from "@eidolon/config";
import { acquireLock, LockedError } from "@eidolon/config/lock";
import {
  completeText,
  createMind,
  type Mind,
  type MindToolCall,
  runTask,
  type TaskBrief,
  type TaskEntry,
  type TaskEvent,
  type TaskGateDecision,
  type TaskInbox,
  type TaskOutcome,
  type TaskRefusal,
  type TaskRequest,
  type TaskStore,
  UsageMeter,
} from "@eidolon/engine";
import {
  accountOf,
  ProviderConfigError,
  roleSearcher,
  selectTask,
  type UsageRecord,
  type UsageSink,
  withUsageScope,
} from "@eidolon/providers";
import manifest from "../../../package.json" with { type: "json" };
import {
  type AllowedCommand,
  type ErrorCode,
  type McpServerChange,
  type McpServersResponse,
  type SkillCreate,
  type SkillsResponse,
  STEER_PREFIX,
  type TaskApproveRequest,
  type TaskContinueRequest,
  type TaskModel,
  type TasksQuery,
} from "../api.ts";
import { followLines } from "../jobs/events.ts";
import { ALLOWED_COMMANDS_FILE, AllowedCommands } from "./commands.ts";
import { MCP_FOLDER, McpFile, mcpServersView } from "./mcp.ts";
import { doneOf } from "./milestones.ts";
import { insideAny, placeOf } from "./places.ts";
import { OwnerSkills } from "./skills.ts";
import { SnapshotFile } from "./snapshot-file.ts";

/** start_task's arguments: OpenClaw's objective, output, write scope and verification. */
export interface TaskBriefInput {
  readonly goal: string;
  /** The goal when absent. */
  readonly deliverable?: string;
  /** Absolute, or under ~. */
  readonly folder: string;
  readonly check?: string;
  /** The kind of task she says it is, whose model it runs on; Assistant Mode's own when absent. */
  readonly profile?: TaskProfile;
  /** The owner's skills she named for it, whose SKILL.md its prompt carries whole. */
  readonly skills?: readonly string[];
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
  /**
   * Told when a todo result raises the done count of a task's plan, once the snapshot holds it;
   * never for one a resume reads back. A throw is logged.
   */
  readonly progress?: (snapshot: TaskSnapshot) => void;
  /**
   * How a run's web_search searches, billing each search through `charge`; undefined when the
   * search role can't search. Default: the search role's account, as it stands at the run's start.
   */
  readonly searcher?: (charge: UsageSink) => WebSearcher | undefined;
  /** How each task's commands run: tests shorten the yield. Default: BashJobs' own. */
  readonly bash?: Omit<BashJobsOptions, "onChange">;
  /**
   * The permission level a task of `chat` acts under: the chat's own, else the app's. Read at each
   * question it would ask, so a change reaches a running task at its next one; a throw reads as
   * `ask`. Default: the app's.
   */
  readonly permissions?: (chat: TaskChat) => Promise<PermissionLevel>;
  /** How long Approve for Me's review may take before the card asks instead: tests shorten it. */
  readonly reviewTimeoutMs?: number;
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
  | "unknown-command"
  | "unknown-mcp-server"
  | "invalid-mcp-config"
  | "linked-mcp-config"
  | "unknown-skill"
  | "skill-exists"
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
const DEFAULT_CHECK = "Check the deliverable against the goal";
const STEER_MAX_CHARS = 2000;
const STEP_HEAD_CHARS = 120;
/** What names a call's step, in this order, before the JSON of all its arguments. */
const STEP_KEYS = ["path", "url", "pattern", "glob", "query", "command", "name"] as const;
const COMMANDS_OFF = "The owner turned commands off, so bash can't run anything now.";
const COMMAND_DENIED = "The owner refused to run this command in this task; don't run it again.";
const MCP_CROWDED =
  "This call has too many arguments, or names too long, to show the owner on the task's card. " +
  "Make it with fewer.";
/**
 * The most an MCP call's arguments may take as JSON on its card: an answer sends them back, to a
 * route that takes 16 KB.
 */
const CARD_ARGUMENTS_BYTES = 12 * 1024;

const ANSWERS: ReadonlySet<unknown> = new Set(["once", "always", "deny"]);
/**
 * Approve for Me's default deadline. The benchmark's reviews took 0.6 to 8 s; a stream that
 * stalls would otherwise hold a start, and every start after it.
 */
const REVIEW_TIMEOUT_MS = 60_000;
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
  /** What the gate paused to ask: a site, a command, or an MCP call. */
  asked: Extract<TaskPending, { readonly kind: "fetch" | "command" | "mcp" }> | null;
  /**
   * The path the latest batch asks about: its first refused, or the one Approve for Me's review
   * asked about, with why.
   */
  refused: (TaskRefusal & { readonly review?: ReviewReason }) | null;
  /**
   * Full Access, as the gate last read the level for a web_fetch: the call, and its redirects, may
   * then reach any site the owner hasn't refused.
   */
  full: boolean;
  /** How the run ended or paused, once its transcript says so. */
  last: TaskOutcome | null;
  /** The calls of the latest reply: stored before the run, or made in it. */
  calls: readonly MindToolCall[];
  /** The MCP calls the run started: whatever each returns came from outside. */
  served: Set<string>;
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
  /** Its commands, across its runs: opened by its first run with bash, or at the server's start. */
  jobs: BashJobs | null;
  /**
   * The commands the owner's Run Once let through, each for the call that asked. In memory, and
   * only until the worker's next reply or the run's end: a call a steering line skipped must not
   * leave one for a later call that reuses its id.
   */
  once: { readonly call: string; readonly command: string }[];
  /** Its MCP servers: started by its first run, kept through its pauses, closed when it ends. */
  mcp: McpSession | null;
  /**
   * The MCP calls the owner's Run Once let through, each by its call and key. In memory, and only
   * until the worker's next reply or the task's end. Unlike `once`, kept through a pause: MCP calls
   * run together, and a pause on a later call of the same reply gates every one of them again.
   */
  mcpOnce: { readonly call: string; readonly key: string }[];
  /** Wakes each events stream following the task. */
  readonly readers: Set<() => void>;
}

/**
 * A run's policy, which a grant its chat's level makes while it runs replaces, so the call the
 * worker makes again finds it.
 */
class RunGuard implements PathGuard {
  #policy: FolderPolicy;

  constructor(policy: FolderPolicy) {
    this.#policy = policy;
  }

  get folder(): string {
    return this.#policy.folder;
  }

  resolve(path: string, access: "read" | "write"): Promise<string> {
    return this.#policy.resolve(path, access);
  }

  replace(policy: FolderPolicy): void {
    this.#policy = policy;
  }
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

/** What an Allow of `path` grants: its `folder` (#folderFor's), else the path alone. */
function grantOf(path: string, access: "read" | "write", folder: string | undefined): FolderGrant {
  return { path: folder ?? path, access: access === "write" ? "read-write" : "read" };
}

function holds(grants: readonly FolderGrant[], grant: FolderGrant): boolean {
  return grants.some((each) => each.path === grant.path && each.access === grant.access);
}

/** What a run is told of a grant its chat's level made, where an answer says the owner allowed it. */
function grantedLine({ path, access }: FolderGrant): string {
  return `${access === "read" ? "Read" : "Read-write"} access to ${path} is allowed now. Try again.`;
}

/**
 * What `level` makes of an action the owner would be asked about: null to let it through (Full
 * Access, or an allow from Approve for Me's `review`), else what the card's question carries:
 * nothing under Ask for Approval, the review's reason under Approve for Me.
 */
async function levelAnswer(
  level: PermissionLevel,
  review: () => Promise<ReviewVerdict>,
): Promise<{ readonly review?: ReviewReason } | null> {
  if (level === "full") return null;
  if (level === "ask") return {};
  const verdict = await review();
  return verdict.allow ? null : { review: verdict.reason };
}

/** What the log says of an action Approve for Me's review decided. */
function actionHead(action: ReviewedAction): string {
  switch (action.kind) {
    case "start":
      return `the start in ${action.folder}`;
    case "path":
      return `${action.access} access to ${action.path}`;
    case "fetch":
      return `a fetch from ${action.host}`;
    case "command":
      return "a command";
    case "mcp":
      return `${action.tool} on the MCP server ${action.server}`;
  }
}

/** A call's step as the snapshot names it: its path, url, pattern, glob or query, else its JSON. */
function stepHead(args: Readonly<Record<string, unknown>>): string {
  const named = STEP_KEYS.map((key) => args[key]).find((value) => typeof value === "string");
  const head = [...(typeof named === "string" ? named : JSON.stringify(args))];
  return head.length > STEP_HEAD_CHARS
    ? `${head.slice(0, STEP_HEAD_CHARS).join("")}…`
    : head.join("");
}

/** What an outcome other than a pause makes of its task. */
function endedChanges(
  outcome: Exclude<TaskOutcome, { status: "paused" }>,
  endedAt: number,
): Changes {
  return {
    status: outcome.status,
    outcome,
    endedAt,
    pending: undefined,
    pause: undefined,
    inbox: undefined,
  };
}

/** What `outcome` makes of a task whose run just ended; null: the server stopped it. */
function settledChanges(run: Run, outcome: TaskOutcome | null, endedAt: number): Changes {
  if (outcome === null) return { status: "interrupted" };
  if (outcome.status !== "paused") return endedChanges(outcome, endedAt);
  let pending: TaskPending | undefined;
  if (outcome.reason === "approval") {
    if (run.asked !== null) pending = run.asked;
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

/**
 * `store`, keeping on `run` the calls of the last reply it holds: a resume runs them. `read` is told
 * of the entries the run starts from, `replied` of each new reply as it is stored, before the run
 * gates its calls, and `took` of each line from the inbox once it is stored.
 */
function noting(
  store: TaskStore,
  run: Run,
  hooks: {
    readonly read: (entries: readonly TaskEntry[]) => void;
    readonly replied: () => void;
    readonly took: (kind: keyof TaskInboxLines) => void;
  },
): TaskStore {
  return {
    entries: async () => {
      const entries = await store.entries();
      const last = entries.findLast((entry) => entry.type === "assistant");
      if (last?.type === "assistant") run.calls = last.calls;
      hooks.read(entries);
      return entries;
    },
    append: async (draft) => {
      if (draft.type === "assistant") hooks.replied();
      const entry = await store.append(draft);
      if (draft.type === "steer") hooks.took("steer");
      else if (draft.type === "follow-up") hooks.took("followUp");
      return entry;
    },
  };
}

/**
 * Every argument of an MCP call for its card, each head cut shorter until they fit; null when
 * their names and sizes alone don't.
 */
function cardArguments(args: Readonly<Record<string, unknown>>): McpArgument[] | null {
  let list = mcpArgumentList(args);
  let head = list.reduce((most, arg) => Math.max(most, arg.head.length), 0);
  while (Buffer.byteLength(JSON.stringify(list)) > CARD_ARGUMENTS_BYTES) {
    if (head === 0) return null;
    head = Math.floor(head / 2);
    list = list.map((arg) => ({ ...arg, head: sliceHead(arg.head, head) }));
  }
  return list;
}

/** What the task's card says of its MCP servers; undefined while there is nothing. */
function mcpNotes(
  denied: readonly string[],
  failed: readonly McpFailure[],
  left: readonly McpLeftOut[],
): TaskSnapshot["mcp"] {
  if (denied.length === 0 && failed.length === 0 && left.length === 0) return undefined;
  return {
    denied,
    ...(failed.length === 0 ? {} : { failed }),
    ...(left.length === 0 ? {} : { left }),
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
    case "command":
      return asked.call === pending.call && asked.command === pending.command;
    case "mcp":
      return asked.call === pending.call && asked.key === pending.key;
  }
}

/**
 * Whether a tool's result brought outside content into the task: a page's answer to web_fetch, an
 * error page's included, or a web search's results.
 */
function readsOutside(name: string, isError: boolean, details: unknown): boolean {
  if (name === WEB_FETCH) return details !== undefined;
  return name === WEB_SEARCH && !isError;
}

/**
 * Whether a transcript holds outside content: readsOutside's results, or an MCP call that started.
 * task.json says so within a second of the result, so a server that died in between leaves only
 * the transcript knowing.
 */
function heldOutside(entries: readonly TaskEntry[]): boolean {
  return entries.some((entry) =>
    entry.type === "tool-result"
      ? readsOutside(entry.name, entry.isError, entry.details)
      : entry.type === "tool-start" && entry.name.startsWith(MCP_TOOL_PREFIX),
  );
}

/** `files` with each file a transcript's results read or wrote, which task.json lags as it does. */
function filesHeld(
  files: TaskSnapshot["files"],
  entries: readonly TaskEntry[],
): TaskSnapshot["files"] {
  let { read, written } = files;
  for (const entry of entries) {
    if (entry.type !== "tool-result") continue;
    read = adding(read, entry.files?.read);
    written = adding(written, entry.files?.written);
  }
  return read === files.read && written === files.written ? files : { read, written };
}

/** What a run's skills left out, and why: Settings shows the owner's, the log the rest. */
function logSkills(
  id: string,
  { problems, unlisted, missing, switchesProblem }: SkillCatalog,
  { unreadable }: TaskSkills,
): void {
  if (switchesProblem !== null) {
    logger.warning(`Task ${id}: skills.json ${switchesProblem}, so no skill is switched off`);
  }
  for (const { path, message, skipped } of [...problems, ...unreadable]) {
    logger.warning(`Task ${id}: ${skipped ? "skipping " : ""}skill ${path}: ${message}`);
  }
  if (unlisted.length > 0) {
    logger.warning(`Task ${id}: ${unlisted.length} more skills aren't listed: its catalog is full`);
  }
  if (missing.length > 0) {
    logger.warning(`Task ${id}: no longer has the skills it was given: ${missing.join(", ")}`);
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
  readonly #progress: ((snapshot: TaskSnapshot) => void) | undefined;
  readonly #searcher: (charge: UsageSink) => WebSearcher | undefined;
  readonly #bash: Omit<BashJobsOptions, "onChange">;
  readonly #permissions: (chat: TaskChat) => Promise<PermissionLevel>;
  readonly #reviewTimeoutMs: number;
  /** Aborted once the server stops, and a start's review with it. */
  readonly #stopping = new AbortController();
  /** The commands the owner allowed for good. */
  readonly #allowed: AllowedCommands;
  /** mcp.json, where Always Allow This Tool goes. */
  readonly #mcpFile: McpFile;
  /** The owner's skills and their switches. */
  readonly #skills: OwnerSkills;
  readonly #tasks = new Map<string, Task>();
  readonly #streams = new Set<() => void>();
  #loaded: Promise<void> | null = null;
  #starts: Promise<unknown> = Promise.resolve();
  #guards: Omit<FolderPolicyOptions, "folder" | "grants"> | null = null;

  constructor(options: TaskManagerOptions) {
    this.#dataHome = options.dataHome;
    this.#root = tasksDir(options.dataHome);
    this.#settings = options.settings;
    this.#addFolder = options.addFolder;
    this.#problem = options.problem;
    this.#createMind = options.createMind ?? createMind;
    this.#now = options.now ?? Date.now;
    this.#report = options.report;
    this.#waiting = options.waiting;
    this.#progress = options.progress;
    this.#searcher = options.searcher ?? roleSearcher;
    this.#bash = options.bash ?? {};
    this.#permissions = options.permissions ?? (async () => this.#settings().permissions);
    this.#reviewTimeoutMs = options.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS;
    this.#allowed = new AllowedCommands(join(this.#root, ALLOWED_COMMANDS_FILE), this.#now);
    this.#mcpFile = new McpFile(options.dataHome);
    this.#skills = new OwnerSkills(options.dataHome);
    // Scanned now, so her first turn's start_task can name them.
    this.#skills.names();
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
      ({ snapshot }) => isEnded(snapshot.status) && snapshot.reported !== true,
    );
    void (async () => {
      for (const task of unreported)
        if (!this.#stopping.signal.aborted) await this.#reportEnd(task);
    })();
  }

  /**
   * The server's stop: every run is left, interrupted, for the next start to resume, every command
   * killed, which that run then hears of, and every MCP server closed.
   */
  async stop(): Promise<void> {
    this.#stopping.abort();
    for (const close of [...this.#streams]) close();
    for (const task of this.#tasks.values()) task.run?.leave.abort();
    await this.#starts;
    const tasks = [...this.#tasks.values()];
    await Promise.all(tasks.map((task) => task.queue));
    // A run launched meanwhile was left as it launched.
    await Promise.all(tasks.map((task) => task.run?.settled));
    // After the runs are left: a run still reading would take the ends as told, storing nothing.
    await Promise.all(tasks.map((task) => task.jobs?.killAll("shutdown")));
    // After too, so that servers a run was still starting are closed with the rest.
    await Promise.all(tasks.map((task) => this.#closeMcp(task)));
    await Promise.all(tasks.map((task) => task.file.flush()));
  }

  /** Assistant Mode is on, and a task's mind can be made. */
  ready(): boolean {
    return this.#settings().enabled && this.#problem() === null;
  }

  /** Tasks may ask to run commands: assistant.bash is on, on macOS or Linux. */
  offersCommands(): boolean {
    return this.#settings().bash && bashOffered();
  }

  /** The commands the owner allowed for good, newest first. */
  allowedCommands(): Promise<AllowedCommand[]> {
    return this.#allowed.list();
  }

  /** Takes back the command allowed for good as `id`, answering with the rest. */
  async disallowCommand(id: string): Promise<AllowedCommand[]> {
    if (!(await this.#allowed.remove(id))) {
      throw new TaskRefused(404, "unknown-command", "No allowed command has that id");
    }
    return this.#allowed.list();
  }

  /** The MCP servers mcp.json gives tasks, as the file stands now. */
  async mcpServers(): Promise<McpServersResponse> {
    return mcpServersView(
      await readMcpConfig(this.#dataHome),
      await readMcpSecrets(this.#dataHome),
    );
  }

  /**
   * The owner's switch for MCP server `name`, or a tool's Always taken back, answering with the
   * servers. A task's next call to a server turned off is refused, and one Always no longer
   * covers asks.
   */
  async changeMcpServer(name: string, change: McpServerChange): Promise<McpServersResponse> {
    const { enabled, revoke } = change;
    const result = await this.#mcpFile.change(name, {
      ...(enabled === undefined ? {} : { enabled }),
      ...(revoke === undefined ? {} : { revoke }),
    });
    if (result === "unknown-server") {
      throw new TaskRefused(404, "unknown-mcp-server", "mcp.json has no server by that name");
    }
    if (result === "invalid-config") {
      throw new TaskRefused(
        409,
        "invalid-mcp-config",
        "mcp.json doesn't parse, so it isn't changed: fix it, then try again",
      );
    }
    if (result === "linked") {
      throw new TaskRefused(
        409,
        "linked-mcp-config",
        "mcp.json is a link, so it isn't changed: change the file it leads to",
      );
    }
    return this.mcpServers();
  }

  /** The names of the owner's skills she may give start_task, without waiting on a scan. */
  skillNames(): readonly string[] {
    return this.#skills.names();
  }

  /** The owner's skills as their folders hold them now, with their switches. */
  skills(): Promise<SkillsResponse> {
    return this.#skills.view();
  }

  /**
   * The owner's switch for the skills named `name`, answering with the skills. A task's next run
   * leaves a skill switched off out, and her next turn can't name it.
   */
  async changeSkill(name: string, enabled: boolean): Promise<SkillsResponse> {
    const result = await this.#skills.change(name, enabled);
    if (result === null) {
      throw new TaskRefused(404, "unknown-skill", "No skill of yours has that name");
    }
    return result;
  }

  /** A new skill of the owner's, in the data home's skills folder, answering with the skills. */
  async createSkill(input: SkillCreate): Promise<SkillsResponse> {
    const result = await this.#skills.create(input);
    if (result === "exists") {
      throw new TaskRefused(409, "skill-exists", "The skills folder has one by that name already");
    }
    if ("invalid" in result) throw new TaskRefused(400, "bad-request", result.invalid);
    return result;
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
    const size = await stat(transcriptPath(task.dir)).then(
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
      if (!isLive(status)) {
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
      if (!isLive(task.snapshot.status)) return null;
      if (task.run === null) {
        await this.#end(task, {});
        return null;
      }
      task.run.cancel.abort();
      return task.run;
    });
    await run?.settled;
    // A run past its last check for the cancel stores its pause anyway, leaving the task live.
    if (run !== null && isLive(task.snapshot.status)) return this.cancel(id);
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
    } catch (error) {
      // None yet is no tasks; anything else leaves them on disk for the next start.
      if ((error as { code?: unknown }).code !== "ENOENT") {
        logger.warning(`Tasks weren't read from ${this.#root}: ${errorText(error)}`);
      }
      return;
    }
    for (const name of names.filter(isTaskId)) {
      const dir = join(this.#root, name);
      try {
        const snapshot = await readSnapshot(dir);
        if (snapshot?.chat === undefined) continue;
        if (snapshot.id !== name) throw new Error(`its task.json is task ${snapshot.id}'s`);
        const task = this.#track(dir, snapshot);
        if (snapshot.status === "running") await this.#crashed(task);
        // Unless another holder still runs it.
        if (task.snapshot.status !== "running") await this.#reopenCommands(task);
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
      jobs: null,
      once: [],
      mcp: null,
      mcpOnce: [],
      readers: new Set(),
    };
    this.#tasks.set(snapshot.id, task);
    return task;
  }

  /**
   * A task's commands as the server starts, when it ran any: none still runs for this server, so a
   * crash's are ended `lost`, which its next run hears of, and its card stops listing them.
   */
  async #reopenCommands(task: Task): Promise<void> {
    const ran = await stat(join(task.dir, "bash")).then(
      () => true,
      () => false,
    );
    if (ran) {
      try {
        task.jobs = await this.#openCommands(task);
      } catch (error) {
        logger.warning(`Task ${task.snapshot.id}'s commands weren't read: ${errorText(error)}`);
      }
    }
    if (task.snapshot.background !== undefined) {
      await this.#change(task, { background: undefined }, true);
    }
  }

  /** The task's registry of commands, which keeps task.json's list of those in the background. */
  #openCommands(task: Task): Promise<BashJobs> {
    return BashJobs.open(task.dir, {
      ...this.#bash,
      onChange: (background) => {
        void this.#change(task, { background: background.length === 0 ? undefined : background });
      },
    });
  }

  /** A task task.json calls running, at load: a crash left it so, unless laplace-task runs it. */
  async #crashed(task: Task): Promise<void> {
    let release: () => void;
    try {
      release = acquireLock(taskLockKey(task.snapshot.id), LOCK_HOLDER);
    } catch (error) {
      if (error instanceof LockedError) return;
      throw error;
    }
    try {
      // A crash between storing the run's end or pause and task.json: resumed, it would run on,
      // past a spend pause too, which a new run counts from its next multiple. An approval's
      // question lives only in its run, so the resume asks it again.
      const last = (await openTaskStore(task.dir).entries()).at(-1);
      let changes: Changes = { status: "interrupted" };
      if (last?.type === "end" && last.outcome.status !== "paused") {
        changes = endedChanges(last.outcome, last.at);
      } else if (last?.type === "pause" && last.reason !== "approval") {
        changes = { status: "paused", pause: { reason: last.reason, detail: last.detail } };
      }
      await this.#change(task, changes, true);
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
      return acquireLock(taskLockKey(id), LOCK_HOLDER);
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
      if (!isLive(snapshot.status)) continue;
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
    const skills = await this.#named(input.skills ?? []);
    const inside = await insideAny(place, settings.folders);
    const { profile } = input;
    let model: TaskModel;
    try {
      const { selection, fallback } = selectTask(profile);
      if (fallback !== null) {
        logger.warning(`A ${profile} task runs on the assistant's model: ${fallback}`);
      }
      model = { account: selection.account.id, model: selection.model };
    } catch (error) {
      if (error instanceof ProviderConfigError) {
        throw new TaskRefused(409, "assistant-not-ready", error.message);
      }
      throw error;
    }
    const id = newTaskId();
    const dir = join(this.#root, id);
    // A start review's spend is the task's.
    const meter = new UsageMeter(model);
    const asked = inside ? null : await this.#startQuestion(id, origin, brief, model, meter);
    const runs = asked === null;
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
      spentUsd: meter.spentUsd(),
      files: { read: [], written: [] },
      web: ASK_EACH_SITE,
      ...(profile === undefined ? {} : { profile }),
      ...(skills.length === 0 ? {} : { skills }),
      ...(asked === null ? {} : { pending: asked }),
    };
    const equipped = runs ? this.#equip(id, model, meter) : null;
    try {
      await openTaskStore(dir).append({ type: "brief", brief });
      await writeSnapshot(dir, snapshot);
    } catch (error) {
      equipped?.release();
      throw error;
    }
    const task = this.#track(dir, snapshot);
    // A waiting start keeps it too: its review's uncounted spend still pauses the first request.
    task.meter = meter;
    if (equipped !== null) this.#launch(task, equipped);
    return task.snapshot;
  }

  /**
   * What a start outside assistant.folders asks the owner, or null when its chat's level lets it
   * run: Full Access, or Approve for Me's review.
   */
  async #startQuestion(
    id: string,
    origin: TaskChat,
    brief: TaskBrief,
    model: TaskModel,
    meter: UsageMeter,
  ): Promise<Extract<TaskPending, { readonly kind: "start" }> | null> {
    const action: ReviewedAction = { kind: "start", folder: brief.folder };
    const why = await levelAnswer(await this.#levelOf(origin), () =>
      withUsageScope({ source: "task", session: id }, () =>
        this.#review({ id, brief, model }, meter, action, this.#stopping.signal),
      ),
    );
    return why === null ? null : { kind: "start", ...why };
  }

  /** The level `chat` has now; `ask` when it can't be read, which lets nothing more through. */
  async #levelOf(chat: TaskChat | undefined): Promise<PermissionLevel> {
    if (chat === undefined) return "ask";
    try {
      return await this.#permissions(chat);
    } catch (error) {
      logger.warning(
        `Chat ${chat.id}'s permission level wasn't read, so its task asks: ${errorText(error)}`,
      );
      return "ask";
    }
  }

  /**
   * Approve for Me's review of `action`, on the task's own model and billed through `meter`: an
   * allow, or why the card asks. One that fails asks, as `failed`.
   */
  async #review(
    task: Pick<TaskSnapshot, "id" | "brief" | "model" | "external">,
    meter: UsageMeter,
    action: ReviewedAction,
    signal: AbortSignal,
  ): Promise<ReviewVerdict> {
    const { id, brief, model } = task;
    if (!reviewable(action)) {
      logger.info(`Task ${id}: Approve for Me can't see ${actionHead(action)} whole, so it asks`);
      return { allow: false, reason: "unclear" };
    }
    let verdict: ReviewVerdict;
    try {
      let reported = false;
      // `charge`, never `tap`: a review is no worker request, and its size isn't the context's.
      const charge = (record: UsageRecord) => {
        reported = true;
        meter.charge(record);
      };
      const mind = this.#createMind("assistant", { ...model, tap: charge });
      const prompt = reviewPrompt({ brief, external: task.external === true, action });
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.#reviewTimeoutMs)]);
      verdict = parseReview(
        await completeText(mind, { system: REVIEW_SYSTEM, prompt, signal: deadline }),
      );
      // A server may ignore the request for usage, as the worker's requests hear of.
      if (!reported) meter.unreported();
    } catch (error) {
      logger.warning(
        `Task ${id}: Approve for Me couldn't review ${actionHead(action)}, so it asks: ${errorText(error)}`,
      );
      return { allow: false, reason: "failed" };
    }
    logger.info(
      `Task ${id}: Approve for Me ${verdict.allow ? "allowed" : `asks about (${verdict.reason})`} ${actionHead(action)}`,
    );
    return verdict;
  }

  /** #review for an action of `run`'s, which its Stop or the server's stop aborts. */
  #reviewIn(task: Task, run: Run, action: ReviewedAction): Promise<ReviewVerdict> {
    const signal = AbortSignal.any([run.cancel.signal, run.leave.signal]);
    return this.#review(task.snapshot, run.meter, action, signal);
  }

  /**
   * The owner's skills `names` gives, as a task keeps them. Refused, so she can tell the owner, when
   * one is switched off or the owner has none by that name.
   */
  async #named(names: readonly string[]): Promise<readonly string[]> {
    if (names.length === 0) return [];
    const scan = await scanSkills({ dataHome: this.#dataHome, shared: sharedSkillsDir() });
    const { requested, missing, off } = catalogOf(scan, names);
    if (missing.length === 0) return requested.map((skill) => skill.name);
    const unknown = missing.filter((name) => !off.includes(name));
    if (unknown.length === 0) {
      const one = off.length === 1;
      throw new TaskRefused(
        400,
        "unknown-skill",
        `The skill${one ? "" : "s"} ${off.join(", ")} ${one ? "is" : "are"} switched off in Settings, so no task can use ${one ? "it" : "them"}.`,
      );
    }
    const offered = skillNames(scan);
    throw new TaskRefused(
      400,
      "unknown-skill",
      `There is no skill named ${unknown.join(" or ")}. ` +
        (offered.length === 0 ? "There are no skills." : `The skills are ${offered.join(", ")}.`),
    );
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
      let changes: Changes;
      if (pending.kind === "path") changes = await this.#answerPath(task, pending, answer);
      else if (pending.kind === "fetch") changes = this.#answerSite(task, pending.host, answer);
      else if (pending.kind === "command")
        changes = await this.#answerCommand(task, pending, answer);
      else changes = await this.#answerMcp(task, pending, answer);
      return await this.#run(task, equipped, changes);
    } catch (error) {
      equipped.release();
      throw error;
    }
  }

  /**
   * A command's answer, which reaches the worker as its call's result once the run gates the call
   * again: what the command printed, or the refusal.
   */
  async #answerCommand(
    task: Task,
    { call, command }: Extract<TaskPending, { readonly kind: "command" }>,
    answer: Answer,
  ): Promise<Changes> {
    if (answer === "deny") {
      const denied = task.snapshot.bash?.denied ?? [];
      return { bash: { denied: denied.includes(command) ? denied : [...denied, command] } };
    }
    if (answer === "always") {
      const folder = await placeOf(task.snapshot.brief.folder);
      await this.#allowed.add(folder, command, task.snapshot.id);
    }
    // Always too: a task that has read outside content asks even for a command allowed for good.
    task.once.push({ call, command });
    return {};
  }

  /**
   * An MCP call's answer, which reaches the worker as its call's result once the run gates the
   * call again: what the server answered, or the refusal. Always joins the tool to its server's
   * alwaysAllow in mcp.json.
   */
  async #answerMcp(
    task: Task,
    { server, tool, call, key }: Extract<TaskPending, { readonly kind: "mcp" }>,
    answer: Answer,
  ): Promise<Changes> {
    if (answer === "deny") {
      const { mcp } = task.snapshot;
      const denied = mcp?.denied ?? [];
      return { mcp: { ...mcp, denied: denied.includes(key) ? denied : [...denied, key] } };
    }
    const saved = answer === "always" ? await this.#mcpFile.change(server, { allow: tool }) : null;
    if (saved === "invalid-config") {
      throw new TaskRefused(
        409,
        "invalid-mcp-config",
        "mcp.json doesn't parse, so Always can't be saved in it: fix it, or answer Run Once",
      );
    }
    if (saved === "linked") {
      throw new TaskRefused(
        409,
        "linked-mcp-config",
        "mcp.json is a link, so Always can't be saved in it: change the file it leads to, or answer Run Once",
      );
    }
    // Always too: under No Web, or in a task that has read outside content, the grant doesn't apply.
    task.mcpOnce.push({ call, key });
    return {};
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
    if (answer === "deny") {
      const denied = task.snapshot.paths?.denied ?? [];
      return {
        ...tell(`The owner refused access to ${path}.`),
        paths: { denied: denied.includes(path) ? denied : [...denied, path] },
      };
    }
    // Every task may read and write assistant.folders: only a write's folder joins them, never a file.
    if (answer === "always" && access === "write" && folder !== undefined) {
      await this.#addFolder(folder);
    }
    const grant = grantOf(path, access, folder);
    const { grants } = task.snapshot;
    return {
      grants: holds(grants, grant) ? grants : [...grants, grant],
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
    // A paused task's commands in the background, and its MCP servers, end with it.
    void task.jobs?.killAll("stopped");
    void this.#closeMcp(task);
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
      ({ snapshot }) => isLive(snapshot.status) && which(snapshot),
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
      full: false,
      last: null,
      calls: [],
      served: new Set(),
    };
    task.meter = meter;
    task.run = run;
    if (this.#stopping.signal.aborted) run.leave.abort();
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
    const guard = new RunGuard(this.#policy(brief.folder, this.#grants(grants)));
    await mkdir(await guard.resolve(brief.folder, "write"), { recursive: true });
    const web = webOf(task.snapshot).mode !== "off";
    // A fetch a restart cut short runs again without the gate, which otherwise sets this.
    run.full = (await this.#levelOf(task.snapshot.chat)) === "full";
    // Asked at each call and redirect, so an approval reaches the tools without making them again.
    const site = {
      allows: (host: string) => {
        const access = webOf(task.snapshot);
        return allows(access, host) || (run.full && !access.denied.includes(host));
      },
    };
    const search = web ? this.#searcher(run.meter.charge) : undefined;
    const commands = this.offersCommands();
    if (commands) task.jobs ??= await this.#openCommands(task);
    // Read at each run, so a resumed task finds a skill added since, and none switched off since.
    const skills = await loadSkills({
      dataHome: this.#dataHome,
      shared: sharedSkillsDir(),
      folder: brief.folder,
      requested: task.snapshot.skills ?? [],
    });
    const named = await taskSkills(skills, guard, this.#settings().contextTokens);
    logSkills(id, skills, named);
    const mcp = await this.#mcpOf(task, run, guard);
    const tools = [
      ...createTaskTools(guard, {
        ...(web ? { web: site } : {}),
        ...(search === undefined ? {} : { search }),
        ...(commands && task.jobs !== null ? { bash: task.jobs } : {}),
        skills: named.loadable,
      }),
      // Last, so the built-ins keep their place in the provider's prompt cache.
      ...(mcp?.tools ?? []),
    ];
    const contextFiles = await loadContextFiles(brief.folder, this.#home, guard);
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
        skills: skills.skills,
        requested: named.requested,
        date: taskDate(new Date(this.#now())),
      }),
      tools,
      store: untilLeft(
        noting(openTaskStore(task.dir), run, {
          read: (entries) => {
            const changes: Changes = {};
            const files = filesHeld(task.snapshot.files, entries);
            if (files !== task.snapshot.files) changes.files = files;
            if (task.snapshot.external !== true && heldOutside(entries)) changes.external = true;
            if (Object.keys(changes).length > 0) void this.#change(task, changes);
          },
          // A Run Once is for the call the run resumes with: some providers reuse call ids.
          replied: () => {
            task.once = [];
            task.mcpOnce = [];
          },
          took: (kind) => this.#took(task, kind),
        }),
        left,
      ),
      inbox: this.#inbox(task, run),
      meter: run.meter,
      gate: async (call) => this.#gate(task, run, call),
      limits: { contextTokens: this.#settings().contextTokens, spendPauseUsd },
      compaction: { system: COMPACTION_SYSTEM, instructions: COMPACTION_INSTRUCTIONS },
      pauseOnRefused: (refused) => this.#refusedAsks(task, run, guard, refused),
      // A run that was left takes no ends: they wait in runs.json for the run that resumes it.
      ...(task.jobs === null ? {} : { background: task.jobs.forRun(left) }),
      signal: run.cancel.signal,
    };
  }

  /**
   * The task's MCP servers, started by its first run; null when the run was stopped or left as
   * they started, or they couldn't be, and it goes on without them.
   */
  async #mcpOf(task: Task, run: Run, guard: PathGuard): Promise<McpSession | null> {
    if (task.mcp !== null) return task.mcp;
    const { id } = task.snapshot;
    // A server stuck starting, or an npx download, must not hold up a Stop or the server's stop.
    const signal = AbortSignal.any([run.cancel.signal, run.leave.signal]);
    let failed: readonly McpFailure[];
    try {
      task.mcp = await McpSession.open({
        config: await readMcpConfig(this.#dataHome),
        secrets: await readMcpSecrets(this.#dataHome),
        cwd: join(this.#dataHome, MCP_FOLDER),
        guard,
        version: manifest.version,
        signal,
      });
      failed = task.mcp.failed;
    } catch (error) {
      // The run then ends as the Stop or the server's stop says.
      if (signal.aborted) return null;
      failed = [{ error: errorText(error) }];
    }
    for (const { server, error } of failed) {
      logger.warning(`Task ${id} works without ${server ?? "its MCP servers"}: ${error}`);
    }
    const notes = mcpNotes(task.snapshot.mcp?.denied ?? [], failed, task.mcp?.left ?? []);
    await this.#change(task, { mcp: notes });
    return task.mcp;
  }

  /** Closes the task's MCP servers, process groups and all; resolves once they are gone. */
  #closeMcp(task: Task): Promise<void> {
    const session = task.mcp;
    task.mcp = null;
    task.mcpOnce = [];
    return session?.close() ?? Promise.resolve();
  }

  /**
   * Asks the owner, before a call starts, for each site, command and MCP call the task may not
   * make yet, unless its chat's level lets the call through.
   */
  async #gate(task: Task, run: Run, call: MindToolCall): Promise<TaskGateDecision> {
    const mcp = task.mcp?.toolOf(call.name);
    if (mcp !== undefined) return this.#gateMcp(task, run, call, mcp);
    if (call.name === WEB_FETCH) return this.#gateSite(task, run, call);
    if (call.name === BASH) return this.#gateCommand(task, run, call);
    return null;
  }

  /**
   * Each call to an MCP server's tool waits on the task's card, unless the owner always allows that
   * tool, or the chat's level lets it through: neither under No Web, and the owner's Always not in
   * a task that has read outside content, which could have talked the worker into the call.
   * mcp.json is read at each call, so a server turned off since the task started gets no more.
   */
  async #gateMcp(
    task: Task,
    run: Run,
    call: MindToolCall,
    { server, tool, hint }: McpToolRef,
  ): Promise<TaskGateDecision> {
    const standing = mcpStanding(await readMcpConfig(this.#dataHome), server, tool);
    if (standing === "off") {
      return {
        block: `The owner turned off the MCP server ${server}; don't call its tools again.`,
      };
    }
    const key = mcpCallKey(call.name, call.arguments);
    const { snapshot } = task;
    if (snapshot.mcp?.denied.includes(key)) {
      return {
        block: `The owner refused this call to ${tool} on the MCP server ${server}; don't make it again with the same arguments.`,
      };
    }
    if (task.mcpOnce.some((each) => each.call === call.id && each.key === key)) return null;
    const noWeb = webOf(snapshot).mode === "off";
    if (standing === "always" && !noWeb && snapshot.external !== true) return null;
    const action: ReviewedAction = {
      kind: "mcp",
      server,
      tool,
      arguments: call.arguments,
      ...(hint === undefined ? {} : { hint }),
    };
    const level = noWeb ? "ask" : await this.#levelOf(snapshot.chat);
    const why = await levelAnswer(level, () => this.#reviewIn(task, run, action));
    if (why === null) return null;
    const args = cardArguments(call.arguments);
    if (args === null) return { block: MCP_CROWDED };
    run.asked = {
      kind: "mcp",
      server,
      tool,
      call: call.id,
      key,
      args,
      ...(hint === undefined ? {} : { hint }),
      ...why,
    };
    return { pause: `run ${tool} on the MCP server ${server}` };
  }

  async #gateSite(task: Task, run: Run, call: MindToolCall): Promise<TaskGateDecision> {
    // Null: the tool refuses the call whatever the owner says.
    const host = webFetchHost(call.arguments);
    if (host === null) return null;
    if (webOf(task.snapshot).denied.includes(host)) {
      return { block: `The owner refused fetching from ${host}.` };
    }
    const level = await this.#levelOf(task.snapshot.chat);
    // Its redirects too, which the tool asks `allows` about.
    run.full = level === "full";
    if (run.full || allows(webOf(task.snapshot), host)) return null;
    const url = typeof call.arguments.url === "string" ? call.arguments.url : host;
    const why = await levelAnswer(level, () =>
      this.#reviewIn(task, run, { kind: "fetch", url, host }),
    );
    if (why === null) {
      await this.#change(task, this.#answerSite(task, host, "once"), true);
      return null;
    }
    run.asked = { kind: "fetch", host, ...why };
    return { pause: `fetch from ${host}` };
  }

  /**
   * A command runs once the owner allows it on the task's card, this call alone or for good in the
   * task's folder, or the chat's level lets it through. A command allowed for good asks again in a
   * task that has read outside content, which could have talked the worker into changing what
   * that command runs.
   */
  async #gateCommand(task: Task, run: Run, call: MindToolCall): Promise<TaskGateDecision> {
    // Null: the tool refuses the call whatever the owner says.
    const command = bashCommand(call.arguments);
    if (command === null) return null;
    // A run made before the owner turned commands off still has bash.
    if (!this.#settings().bash) return { block: COMMANDS_OFF };
    const { snapshot } = task;
    if (snapshot.bash?.denied.includes(command)) return { block: COMMAND_DENIED };
    if (task.once.some((each) => each.call === call.id && each.command === command)) return null;
    const granted = await this.#allowed.allows(await placeOf(snapshot.brief.folder), command);
    if (granted && snapshot.external !== true) return null;
    const action: ReviewedAction = { kind: "command", command, folder: snapshot.brief.folder };
    const why = await levelAnswer(await this.#levelOf(snapshot.chat), () =>
      this.#reviewIn(task, run, action),
    );
    if (why === null) return null;
    run.asked = {
      kind: "command",
      call: call.id,
      command,
      timeout: bashTimeoutSeconds(call.arguments),
      ...(granted ? { granted: true } : {}),
      ...why,
    };
    return { pause: "run a command" };
  }

  /**
   * Whether a batch's refused paths wait on the owner. Under Full Access each is granted as Allow
   * Once would grant it, and under Approve for Me each its review allows, and the run goes on, told
   * so; the first one the review asks about pauses it, with those allowed before it granted.
   */
  async #refusedAsks(
    task: Task,
    run: Run,
    guard: RunGuard,
    refused: readonly TaskRefusal[],
  ): Promise<boolean> {
    const level = await this.#levelOf(task.snapshot.chat);
    if (level === "ask") return true;
    const granted: FolderGrant[] = [];
    const denied = task.snapshot.paths?.denied ?? [];
    for (const { path, access } of refused) {
      const grant = grantOf(path, access, this.#folderFor(path));
      if (holds(granted, grant)) continue;
      // The owner's Deny holds at every level: a grant that holds or lies in it asks again.
      const refusedBefore = denied.some(
        (place) => isInside(place, grant.path) || isInside(grant.path, place),
      );
      const action: ReviewedAction = { kind: "path", path, access, grants: grant.path };
      const why = refusedBefore
        ? {}
        : await levelAnswer(level, () => this.#reviewIn(task, run, action));
      if (why !== null) {
        run.refused = { path, access, ...why };
        if (granted.length > 0) await this.#grantMidRun(task, guard, granted);
        return true;
      }
      granted.push(grant);
    }
    return !(await this.#grantMidRun(task, guard, granted));
  }

  /**
   * Grants `grants` to the task and its running guard, each with the line that tells the worker;
   * false, granting nothing, when its policy can't take them.
   */
  async #grantMidRun(
    task: Task,
    guard: RunGuard,
    grants: readonly FolderGrant[],
  ): Promise<boolean> {
    const { grants: before, brief, inbox } = task.snapshot;
    const all = [...before, ...grants.filter((grant) => !holds(before, grant))];
    try {
      guard.replace(this.#policy(brief.folder, this.#grants(all)));
    } catch (error) {
      logger.warning(`Task ${task.snapshot.id} asks instead: ${errorText(error)}`);
      return false;
    }
    const lines = grants.reduce((lines, grant) => steering(lines, grantedLine(grant)), inbox);
    await this.#change(task, { grants: all, inbox: lines }, true);
    return true;
  }

  /**
   * The run's inbox over task.json's: a line the run takes stays there until the transcript holds
   * it, which the loop stores before it looks again. A run that was left takes none, as its store
   * would refuse the line's entry.
   */
  #inbox(task: Task, run: Run): TaskInbox {
    const take = (kind: keyof TaskInboxLines, all: boolean): readonly string[] => {
      const lines = run.leave.signal.aborted ? [] : (task.snapshot.inbox?.[kind] ?? []);
      return all ? lines : lines.slice(0, 1);
    };
    return {
      hasSteering: () => !run.leave.signal.aborted && (task.snapshot.inbox?.steer.length ?? 0) > 0,
      takeSteering: (all) => take("steer", all),
      takeFollowUps: (all) => take("followUp", all),
    };
  }

  /** Drops the first of the inbox's `kind` lines from task.json, once the transcript holds it. */
  #took(task: Task, kind: keyof TaskInboxLines): void {
    const { inbox } = task.snapshot;
    if (inbox === undefined) return;
    const rest = { ...inbox, [kind]: inbox[kind].slice(1) };
    const empty = rest.steer.length === 0 && rest.followUp.length === 0;
    void this.#change(task, { inbox: empty ? undefined : rest }, true);
  }

  /** Reads the run's events until it ends; null once the server stops reading it. */
  async #read(
    task: Task,
    run: Run,
    reader: AsyncGenerator<TaskEvent, TaskOutcome>,
  ): Promise<TaskOutcome | null> {
    const left = run.leave.signal;
    let done = false;
    try {
      for (;;) {
        const next = await raceAbort(reader.next(), left).catch((error: unknown) => {
          if (left.aborted) return null;
          throw error;
        });
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
      if (task.mcp?.toolOf(entry.name) !== undefined) run.served.add(entry.callId);
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
      // An MCP server's every answer, its errors included: what it says is its own.
      if (readsOutside(entry.name, entry.isError, entry.details) || run.served.has(entry.callId)) {
        changes.external = true;
      }
    }
    if (entry.type === "pause") {
      run.last = { status: "paused", reason: entry.reason, detail: entry.detail };
    }
    if (entry.type === "end") run.last = entry.outcome;
    const furthered =
      changes.todo !== undefined && doneOf(changes.todo) > doneOf(task.snapshot.todo);
    void this.#change(task, changes);
    for (const wake of task.readers) wake();
    if (furthered) this.#tell(task, this.#progress, "progress");
  }

  async #settle(task: Task, run: Run, outcome: TaskOutcome | null): Promise<void> {
    const changes = settledChanges(run, outcome, this.#now());
    const { pending } = changes;
    if (pending?.kind === "path") {
      const folder = this.#folderFor(pending.path);
      if (folder !== undefined) changes.pending = { ...pending, folder };
    }
    task.once = [];
    // Not awaited: the ends are recorded after the task's own, and a paused task keeps them
    // running, as it keeps its MCP servers.
    if (outcome !== null && outcome.status !== "paused") {
      void task.jobs?.killAll("stopped");
      void this.#closeMcp(task);
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
    else if (!run.cancel.signal.aborted) this.#tell(task, this.#waiting, "pause");
  }

  #tell(task: Task, hook: ((snapshot: TaskSnapshot) => void) | undefined, what: string): void {
    try {
      hook?.(task.snapshot);
    } catch (error) {
      logger.exception(`Task ${task.snapshot.id}'s ${what} wasn't told to its chat`, error);
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
    if (!this.#stopping.signal.aborted) await this.#change(task, { reported: true }, true);
  }

  #stream(task: Task, after: number): ReadableStream<Uint8Array> {
    const follow = followLines(transcriptPath(task.dir), after, () => task.run !== null, {
      onClose: () => {
        task.readers.delete(follow.wake);
        this.#streams.delete(follow.close);
      },
    });
    task.readers.add(follow.wake);
    this.#streams.add(follow.close);
    return follow.stream;
  }
}
