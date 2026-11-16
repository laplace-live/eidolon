// A task's files, in `<data home>/tasks/<id>/`: task.json, the snapshot its lists read, and
// transcript.jsonl, every step of its run, which it resumes from. Folders 0700, files 0600.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataHome, isPlainObject } from "@eidolon/config";
import type { TaskBrief, TaskEntry, TaskEntryDraft, TaskOutcome, TaskStore } from "@eidolon/engine";
import type { FolderGrant } from "./policy.ts";

const TRANSCRIPT = "transcript.jsonl";
const SNAPSHOT = "task.json";

export function tasksDir(): string {
  return join(dataHome(), "tasks");
}

/** Time-ordered, so a listing sorted by id is sorted by creation. */
export function newTaskId(): string {
  return Bun.randomUUIDv7();
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

export interface TaskSnapshot {
  readonly v: 1;
  readonly id: string;
  readonly createdAt: number;
  readonly status: TaskStatus;
  readonly persona?: string;
  readonly chat?: string;
  readonly brief: TaskBrief;
  readonly model: { readonly account: string; readonly model: string };
  readonly grants: readonly FolderGrant[];
  readonly spendPauseUsd: number;
  readonly spentUsd: number;
  readonly files: { readonly read: readonly string[]; readonly written: readonly string[] };
  readonly endedAt?: number;
  readonly outcome?: TaskOutcome;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => Number.isFinite(value);
const isStrings = (value: unknown): boolean => Array.isArray(value) && value.every(isString);

function isSnapshot(value: unknown): value is TaskSnapshot {
  if (!isPlainObject(value)) return false;
  const { v, id, createdAt, status, persona, chat, brief, model, grants, files } = value;
  return (
    v === 1 &&
    isString(id) &&
    isNumber(createdAt) &&
    (TASK_STATUSES as readonly unknown[]).includes(status) &&
    (persona === undefined || isString(persona)) &&
    (chat === undefined || isString(chat)) &&
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
      (isPlainObject(value.outcome) && isString(value.outcome.status)))
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

/** Replaces the task's task.json whole: a reader sees the old snapshot or the new one. */
export async function writeSnapshot(dir: string, snapshot: TaskSnapshot): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, SNAPSHOT);
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`);
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
  const path = join(dir, TRANSCRIPT);
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
