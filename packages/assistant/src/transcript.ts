// A task's files, in `<data home>/tasks/<id>/`: task.json, the snapshot its lists read, and
// transcript.jsonl, every step of its run, which it resumes from. Folders 0700, files 0600.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataHome, isPlainObject, type TaskKind } from "@eidolon/config";
import type { TaskBrief, TaskEntry, TaskEntryDraft, TaskOutcome, TaskStore } from "@eidolon/engine";
import type { McpFailure } from "./mcp/session.ts";
import type { McpArgument, McpLeftOut } from "./mcp/tools.ts";
import type { FolderGrant } from "./policy.ts";
import { REVIEW_REASONS, type ReviewReason } from "./review.ts";
import type { BackgroundCommand } from "./tools/jobs.ts";
import { TODO_STATUSES, type TodoItem } from "./tools/todo.ts";

const TRANSCRIPT = "transcript.jsonl";
const SNAPSHOT = "task.json";
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function tasksDir(home: string = dataHome()): string {
  return join(home, "tasks");
}

/** Time-ordered, so a listing sorted by id is sorted by creation. */
export function newTaskId(): string {
  return Bun.randomUUIDv7();
}

/** An id newTaskId makes, so naming a task never names a folder outside the tasks folder. */
export function isTaskId(text: string): boolean {
  return TASK_ID.test(text);
}

/** The lock a task's run holds, in the app and in laplace-task alike. */
export function taskLockKey(id: string): string {
  return `task:${id}`;
}

export function transcriptPath(dir: string): string {
  return join(dir, TRANSCRIPT);
}

export const TASK_STATUSES = [
  "awaiting-approval",
  "running",
  "paused",
  "interrupted",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** It will never run again. */
export function isEnded(status: TaskStatus): status is "succeeded" | "failed" | "cancelled" {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** It runs, or waits to. */
export function isLive(status: TaskStatus): boolean {
  return !isEnded(status);
}

/** The kinds of task with an account and model of their own; she may also call one `other`. */
export const TASK_PROFILES = ["quick", "coding", "research"] as const satisfies readonly TaskKind[];

export type TaskProfile = (typeof TASK_PROFILES)[number];

/**
 * What a task waits on the owner for: to start, a path outside its grants, a site, a command, or
 * a call to an MCP server's tool.
 */
export type TaskPending = (
  | { readonly kind: "start" }
  | {
      readonly kind: "path";
      readonly path: string;
      readonly access: "read" | "write";
      /**
       * What an Allow grants, decided at the pause: the path when it is a folder, else its parent.
       * Absent when that can't be granted, as home can't: the path alone is then.
       */
      readonly folder?: string;
    }
  | { readonly kind: "fetch"; readonly host: string }
  | {
      readonly kind: "command";
      /** The worker's call that asks: an answer naming another call's can't allow this one. */
      readonly call: string;
      /** As it would run: trimmed, and otherwise as the worker wrote it. */
      readonly command: string;
      /** The seconds it may run once started, its time in the background included. */
      readonly timeout: number;
      /** Always in This Folder allows it, but not in a task that has read outside content. */
      readonly granted?: true;
    }
  | {
      readonly kind: "mcp";
      /** The server, as mcp.json names it. */
      readonly server: string;
      /** The tool, as the server lists it. */
      readonly tool: string;
      /** The worker's call that asks: an answer naming another call's can't allow this one. */
      readonly call: string;
      /** mcpCallKey of the call's tool and arguments, which Run Once and Deny hold. */
      readonly key: string;
      /** Every argument the call sends, the shortest first, each with its size. */
      readonly args: readonly McpArgument[];
      /** What the server claims of the tool, which never decides anything. */
      readonly hint?: "read-only" | "destructive";
    }
) & {
  /** Approve for Me's review asked rather than let it through: the risk it named, or `failed`. */
  readonly review?: ReviewReason;
};

/** A task's MCP servers, as its card tells of them. */
export interface TaskMcp {
  /** The calls the owner refused it, by mcpCallKey: it may not make them again. */
  readonly denied: readonly string[];
  /** The servers it works without, or mcp.json itself, and why. */
  readonly failed?: readonly McpFailure[];
  /** How many of a server's tools the limits left out of it. */
  readonly left?: readonly McpLeftOut[];
}

export type TaskPause = Pick<Extract<TaskOutcome, { status: "paused" }>, "reason" | "detail">;

/** Lines for the task's run, kept here until the run takes them. */
export interface TaskInboxLines {
  readonly steer: readonly string[];
  readonly followUp: readonly string[];
}

export const TASK_WEB_MODES = ["ask", "any", "off"] as const;

/** `ask`: the owner allows each site. `off`: the task gets no web_fetch. */
export type TaskWebMode = (typeof TASK_WEB_MODES)[number];

export interface TaskWebAccess {
  readonly mode: TaskWebMode;
  /** Sites allowed while the mode is `ask`. */
  readonly hosts: readonly string[];
  /** Sites the owner refused. */
  readonly denied: readonly string[];
}

/** The latest tool call a task's run started: its tool, and the head of its arguments. */
export interface TaskStep {
  readonly tool: string;
  readonly head: string;
}

/** Where a task started: the chat, the persona in it, and her start_task call's id. */
export interface TaskChat {
  readonly id: string;
  readonly persona: string;
  readonly call: string;
}

export interface TaskSnapshot {
  readonly v: 1;
  readonly id: string;
  readonly createdAt: number;
  readonly status: TaskStatus;
  /** The app's tasks have one; one without it is laplace-task's, which the app never touches. */
  readonly chat?: TaskChat;
  readonly brief: TaskBrief;
  readonly model: { readonly account: string; readonly model: string };
  readonly grants: readonly FolderGrant[];
  readonly spendPauseUsd: number;
  readonly spentUsd: number;
  readonly files: { readonly read: readonly string[]; readonly written: readonly string[] };
  readonly endedAt?: number;
  readonly outcome?: TaskOutcome;
  readonly pending?: TaskPending;
  /** The latest pause, while `paused`. */
  readonly pause?: TaskPause;
  /** The latest list its todo tool wrote. */
  readonly todo?: readonly TodoItem[];
  readonly step?: TaskStep;
  readonly inbox?: TaskInboxLines;
  /** `ask` with no sites when absent. */
  readonly web?: TaskWebAccess;
  /** The kind of task she said it is, whose account and model it runs on; absent for any other. */
  readonly profile?: TaskProfile;
  /** The owner's skills she named for it, whose SKILL.md each run's prompt carries whole. */
  readonly skills?: readonly string[];
  /** The commands the owner refused it, which it may not run again. */
  readonly bash?: { readonly denied: readonly string[] };
  /**
   * The paths the owner refused it: no permission level grants a folder that holds one or lies in
   * one without asking again.
   */
  readonly paths?: { readonly denied: readonly string[] };
  /** Its commands running in the background. */
  readonly background?: readonly BackgroundCommand[];
  /**
   * It has read outside content, such as a page web_fetch got, a web search's results or an MCP
   * server's answer: from then on a command the owner allowed for good in its folder asks again,
   * and so does a tool the owner always allows.
   */
  readonly external?: true;
  /** Absent while it has nothing to say. */
  readonly mcp?: TaskMcp;
  /** Cancelled by the owner's Deny at its start. */
  readonly denied?: true;
  /** Its `final` is stored in its chat; until then the app's next start reports it again. */
  readonly reported?: true;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => Number.isFinite(value);
const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every(isString);
const isOneOf = (list: readonly string[], value: unknown): boolean =>
  isString(value) && list.includes(value);

// A Record, so a reason the engine adds or drops fails the typecheck here.
const PAUSE_REASONS: Readonly<Record<TaskPause["reason"], true>> = {
  spend: true,
  stall: true,
  approval: true,
  unpriced: true,
};

function isPending(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.review !== undefined && !isOneOf(REVIEW_REASONS, value.review)) return false;
  switch (value.kind) {
    case "start":
      return true;
    case "path":
      return (
        isString(value.path) &&
        (value.access === "read" || value.access === "write") &&
        (value.folder === undefined || isString(value.folder))
      );
    case "fetch":
      return isString(value.host);
    case "command":
      return (
        isString(value.call) &&
        isString(value.command) &&
        isNumber(value.timeout) &&
        (value.granted === undefined || value.granted === true)
      );
    case "mcp":
      return (
        [value.server, value.tool, value.call, value.key].every(isString) &&
        Array.isArray(value.args) &&
        value.args.every(
          (arg) =>
            isPlainObject(arg) &&
            isString(arg.name) &&
            isString(arg.head) &&
            Number.isInteger(arg.chars) &&
            Number.isInteger(arg.lines),
        ) &&
        (value.hint === undefined || value.hint === "read-only" || value.hint === "destructive")
      );
    default:
      return false;
  }
}

const isMcp = (value: unknown): boolean =>
  isPlainObject(value) &&
  isStrings(value.denied) &&
  (value.failed === undefined ||
    (Array.isArray(value.failed) &&
      value.failed.every(
        (failure) =>
          isPlainObject(failure) &&
          isString(failure.error) &&
          (failure.server === undefined || isString(failure.server)),
      ))) &&
  (value.left === undefined ||
    (Array.isArray(value.left) &&
      value.left.every(
        (left) => isPlainObject(left) && isString(left.server) && Number.isInteger(left.count),
      )));

const isPause = (value: unknown): boolean =>
  isPlainObject(value) &&
  isOneOf(Object.keys(PAUSE_REASONS), value.reason) &&
  isString(value.detail);

const isTodo = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (item) => isPlainObject(item) && isString(item.text) && isOneOf(TODO_STATUSES, item.status),
  );

const isStep = (value: unknown): boolean =>
  isPlainObject(value) && isString(value.tool) && isString(value.head);

const isInbox = (value: unknown): boolean =>
  isPlainObject(value) && isStrings(value.steer) && isStrings(value.followUp);

const isWebAccess = (value: unknown): boolean =>
  isPlainObject(value) &&
  isOneOf(TASK_WEB_MODES, value.mode) &&
  isStrings(value.hosts) &&
  isStrings(value.denied);

const isChat = (value: unknown): boolean =>
  isPlainObject(value) && [value.id, value.persona, value.call].every(isString);

const isBackground = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (command) =>
      isPlainObject(command) &&
      Number.isInteger(command.id) &&
      isString(command.command) &&
      isNumber(command.startedAt) &&
      isNumber(command.endsAt),
  );

function isSnapshot(value: unknown): value is TaskSnapshot {
  if (!isPlainObject(value)) return false;
  const { v, id, createdAt, status, chat, brief, model, grants, files } = value;
  return (
    v === 1 &&
    isString(id) &&
    isNumber(createdAt) &&
    (TASK_STATUSES as readonly unknown[]).includes(status) &&
    (chat === undefined || isChat(chat)) &&
    isPlainObject(brief) &&
    [brief.goal, brief.deliverable, brief.folder, brief.check].every(isString) &&
    isPlainObject(model) &&
    isString(model.account) &&
    isString(model.model) &&
    Array.isArray(grants) &&
    grants.every(
      (grant) =>
        isPlainObject(grant) &&
        isString(grant.path) &&
        (grant.access === "read" || grant.access === "read-write"),
    ) &&
    isNumber(value.spendPauseUsd) &&
    isNumber(value.spentUsd) &&
    isPlainObject(files) &&
    isStrings(files.read) &&
    isStrings(files.written) &&
    (value.endedAt === undefined || isNumber(value.endedAt)) &&
    (value.outcome === undefined ||
      (isPlainObject(value.outcome) && isString(value.outcome.status))) &&
    (value.pending === undefined || isPending(value.pending)) &&
    (value.pause === undefined || isPause(value.pause)) &&
    (value.todo === undefined || isTodo(value.todo)) &&
    (value.step === undefined || isStep(value.step)) &&
    (value.inbox === undefined || isInbox(value.inbox)) &&
    (value.web === undefined || isWebAccess(value.web)) &&
    (value.profile === undefined || isOneOf(TASK_PROFILES, value.profile)) &&
    (value.skills === undefined || isStrings(value.skills)) &&
    (value.bash === undefined || (isPlainObject(value.bash) && isStrings(value.bash.denied))) &&
    (value.paths === undefined || (isPlainObject(value.paths) && isStrings(value.paths.denied))) &&
    (value.background === undefined || isBackground(value.background)) &&
    (value.external === undefined || value.external === true) &&
    (value.mcp === undefined || isMcp(value.mcp)) &&
    (value.denied === undefined || value.denied === true) &&
    (value.reported === undefined || value.reported === true)
  );
}

/** The task's task.json; null when it has none. Throws when the file isn't a version 1 snapshot. */
export async function readSnapshot(dir: string): Promise<TaskSnapshot | null> {
  const path = join(dir, SNAPSHOT);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not JSON`);
  }
  if (!isSnapshot(value)) throw new Error(`${path} is not a version 1 task snapshot`);
  return value;
}

/** Replaces the file at `path` whole with `text`, as `mode`: a reader sees the old or the new. */
export async function replaceFile(path: string, text: string, mode = 0o600): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(text);
      await handle.datasync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** Replaces the file at `path` whole with `value` as JSON, 0600: a reader sees the old or the new. */
export async function replaceJsonFile(path: string, value: unknown): Promise<void> {
  await replaceFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Replaces the task's task.json whole: a reader sees the old snapshot or the new one. */
export async function writeSnapshot(dir: string, snapshot: TaskSnapshot): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await replaceJsonFile(join(dir, SNAPSHOT), snapshot);
}

/** The transcript as last read or written: its length, that of its whole lines, its last seq. */
interface Known {
  readonly fileSize: number;
  readonly size: number;
  readonly lastSeq: number;
}

/**
 * The entries in `bytes`, without a torn last line: one with no newline after it, or whose JSON
 * doesn't parse, as a crash mid-append leaves. A broken line before it is an error.
 */
function parseTranscript(bytes: Buffer, path: string): { entries: TaskEntry[]; size: number } {
  let size = bytes.lastIndexOf(0x0a) + 1;
  const lines = bytes.subarray(0, size).toString("utf8").split("\n");
  lines.pop();
  const entries: TaskEntry[] = [];
  for (const [i, line] of lines.entries()) {
    try {
      entries.push(JSON.parse(line) as TaskEntry);
    } catch {
      if (i < lines.length - 1) throw new Error(`${path}: line ${i + 1} is not JSON`);
      size -= Buffer.byteLength(line) + 1;
    }
  }
  return { entries, size };
}

/**
 * The transcript in `dir`, created with its first entry. One store writes a task: its calls run
 * one at a time, so entries stored together get their seqs in the order they were appended.
 */
export function openTaskStore(dir: string): TaskStore {
  const path = transcriptPath(dir);
  let known: Known | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  }

  async function read(): Promise<{ entries: TaskEntry[]; known: Known }> {
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      bytes = Buffer.alloc(0);
    }
    const { entries, size } = parseTranscript(bytes, path);
    known = { fileSize: bytes.length, size, lastSeq: entries.at(-1)?.seq ?? 0 };
    return { entries, known };
  }

  return {
    entries: () => serial(async () => (await read()).entries),
    append: (draft: TaskEntryDraft) =>
      serial(async () => {
        const before = known ?? (await read()).known;
        const entry: TaskEntry = { seq: before.lastSeq + 1, at: Date.now(), ...draft };
        const line = `${JSON.stringify(entry)}\n`;
        // Unknown until read again: a failed write may have left part of the line.
        known = null;
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const handle = await open(path, "a", 0o600);
        try {
          if (before.fileSize > before.size) await handle.truncate(before.size);
          await handle.appendFile(line);
          await handle.datasync();
        } finally {
          await handle.close();
        }
        const size = before.size + Buffer.byteLength(line);
        known = { size, fileSize: size, lastSeq: entry.seq };
        return entry;
      }),
  };
}
