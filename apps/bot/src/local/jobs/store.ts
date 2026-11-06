// Jobs on disk, in `<data home>/jobs/`: `<id>.json` holds the record, `<id>.ndjson` the CLI's
// stdout (its events) and `<id>.log` its stderr. Ids are minted here and only ever looked up.
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataHome, errorText, isPlainObject, logger } from "@eidolon/config";
import {
  JOB_COMMANDS,
  JOB_STATUSES,
  type JobCommand,
  type JobRecord,
  type JobStatus,
} from "../api.ts";
import { ensureDataHome, writeDataFile } from "../write.ts";

/** `<YYYYMMDDTHHMMSS>-<6 base32>`, the time in UTC. */
export const JOB_ID = /^\d{8}T\d{6}-[A-Z2-7]{6}$/;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function mintJobId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  const suffix = [...randomBytes(6)].map((byte) => BASE32[byte & 31]).join("");
  return `${stamp}-${suffix}`;
}

/** Why the server told a job to stop: a cancel from the app, or the server itself stopping. */
export type StopReason = "cancel" | "shutdown";

/**
 * A record as its file holds it: the pid lets a later server tell whether the job still runs, and
 * the stop reason, saved before the signal, how a job told to stop ended.
 */
export interface StoredJob extends JobRecord {
  readonly pid: number | null;
  readonly stopReason: StopReason | null;
}

export function jobsDir(): string {
  return join(dataHome(), "jobs");
}

export interface JobFiles {
  readonly record: string;
  readonly events: string;
  readonly log: string;
}

export function jobFiles(id: string): JobFiles {
  const dir = jobsDir();
  return {
    record: join(dir, `${id}.json`),
    events: join(dir, `${id}.ndjson`),
    log: join(dir, `${id}.log`),
  };
}

/** The job's events and log files, new and private to this user, as open descriptors. */
export function createOutputs(files: JobFiles): { events: number; log: number } {
  ensureDataHome();
  mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  const events = openSync(files.events, "wx", 0o600);
  try {
    return { events, log: openSync(files.log, "wx", 0o600) };
  } catch (error) {
    rmSync(files.events, { force: true });
    throw error;
  }
}

export function writeRecord(job: StoredJob): void {
  writeDataFile(jobFiles(job.id).record, `${JSON.stringify(job, null, 2)}\n`);
}

export function removeJob(id: string): void {
  for (const path of Object.values(jobFiles(id))) rmSync(path, { force: true });
}

/** When the job last wrote anything; null when neither output exists. */
export function lastWrite(id: string): Date | null {
  const { events, log } = jobFiles(id);
  let latest: number | null = null;
  for (const path of [events, log]) {
    try {
      latest = Math.max(latest ?? 0, statSync(path).mtimeMs);
    } catch {
      // Never written, or removed.
    }
  }
  return latest === null ? null : new Date(latest);
}

function recordOf(id: string, value: unknown): StoredJob | null {
  if (!isPlainObject(value) || value.id !== id) return null;
  const { command, persona, options, status, startedAt, ephemeral, pid, stopReason } = value;
  if (
    !(JOB_COMMANDS as readonly unknown[]).includes(command) ||
    typeof persona !== "string" ||
    !isPlainObject(options) ||
    !(JOB_STATUSES as readonly unknown[]).includes(status) ||
    typeof startedAt !== "string" ||
    typeof ephemeral !== "boolean"
  ) {
    return null;
  }
  const text = (field: unknown): string | null => (typeof field === "string" ? field : null);
  return {
    id,
    command: command as JobCommand,
    persona,
    options,
    status: status as JobStatus,
    startedAt,
    endedAt: text(value.endedAt),
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    ephemeral,
    resumedFrom: text(value.resumedFrom),
    resumedBy: text(value.resumedBy),
    // Only ever probed with signal 0, where 0 and 1 would name this process group and init.
    pid: typeof pid === "number" && Number.isInteger(pid) && pid > 1 ? pid : null,
    stopReason: stopReason === "cancel" || stopReason === "shutdown" ? stopReason : null,
  };
}

/** Every record in the folder; a file that isn't one is skipped with a warning. */
export function loadRecords(): StoredJob[] {
  let names: string[];
  try {
    names = readdirSync(jobsDir());
  } catch {
    return [];
  }
  const records: StoredJob[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!JOB_ID.test(id)) continue;
    let record: StoredJob | null = null;
    try {
      record = recordOf(id, JSON.parse(readFileSync(jobFiles(id).record, "utf8")));
    } catch (error) {
      logger.warning(`Skipping job ${id}: ${errorText(error)}`);
      continue;
    }
    if (record === null) logger.warning(`Skipping job ${id}: its record is not one`);
    else records.push(record);
  }
  return records;
}
