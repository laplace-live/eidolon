// Where the offline chain reads and writes in the data home, and the locks that keep two runs from
// writing the same files. Everything resolves at call time.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  activePersona,
  dataHome,
  envOptional,
  isPlainObject,
  logger,
  personaHomeDir,
  resolveProjectPath,
  templatesDir,
} from "@eidolon/config";
import { INDEX_DIR } from "@eidolon/retrieval";
import type { ProgressSink, Stage } from "./progress.ts";

export { type SourceFolder, sourceFolder, sourcesDir } from "@eidolon/config";

/**
 * Where the writers build persona `id`'s index: where the bot reads it (`LANCEDB_PATH` or
 * `knowledge.index`, a relative one against the repository root), else
 * `<home>/personas/<id>/index`. Only for the active persona, whose settings are installed; never
 * inside a persona template.
 */
export function indexWritePath(id: string): string {
  const active = activePersona().id;
  if (id !== active) {
    throw new Error(
      `Persona ${id} is not the active persona (${active}); its settings aren't loaded`,
    );
  }
  const configured = envOptional("LANCEDB_PATH");
  const path = configured ? resolveProjectPath(configured) : join(personaHomeDir(id), INDEX_DIR);
  refuseTemplatePath(id, path, "LANCEDB_PATH or knowledge.index");
  return path;
}

/** Throws when `path`, where persona `id`'s index would be written, is in a published template. */
export function refuseTemplatePath(id: string, path: string, setting: string): void {
  // Canonical, so `..`, a symlink or another letter case (APFS folds it) can't slip past.
  const target = canonicalPath(path);
  const templates = canonicalPath(templatesDir());
  if (target === templates || target.startsWith(templates + sep)) {
    throw new Error(
      `Refusing to write persona ${id}'s index into the template folder ${path}; ` +
        `point ${setting} into the data home`,
    );
  }
}

/** The embedding cache every persona shares; the key holds the model and dimension. */
export function embedCachePath(): string {
  return join(dataHome(), "cache", "embed_cache.db");
}

/** Where the managed yt-dlp lives. */
export function binDir(): string {
  return join(dataHome(), "bin");
}

/** Writes `text` to `path` through a temporary file beside it, so no reader sees half a file. */
export function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never written.
    }
    throw error;
  }
}

/** pathlib's `resolve()`: absolute, with the symlinks of its nearest existing ancestor followed. */
export function canonicalPath(path: string): string {
  const missing: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(head), ...missing);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

/** The index writers' lock: one writer per index folder, however its path is spelled. */
export function indexLockKey(dbPath: string): string {
  return `index:${canonicalPath(dbPath)}`;
}

/** Download, transcribe, refine and the pipeline hold this for their whole run. */
export function sourcesLockKey(persona: string): string {
  return `sources:${persona}`;
}

/** Held by the download library while it installs or updates yt-dlp. */
export const YT_DLP_LOCK_KEY = "yt-dlp";

/** Another process holds the lock; the CLI exits 1, or emits code "locked" under --json. */
export class LockedError extends Error {
  override name = "LockedError";
  readonly code = "locked";
  constructor(holder: string, target: string, pid: number | null) {
    super(`Another ${holder} is running for ${target}${pid === null ? "" : ` (pid ${pid})`}.`);
  }
}

/** Another writer holds the index: why, as a failed stage, then the stage's summary. */
export function lockedOut(
  emit: ProgressSink,
  stage: Stage,
  error: LockedError,
  counts: Readonly<Record<string, number>>,
  item: string,
): void {
  logger.error(error.message);
  emit({ type: "stage", stage, status: "failed", code: "locked", message: error.message });
  emit({
    type: "summary",
    stage,
    ok: false,
    counts,
    durationSec: 0,
    failures: [{ item, error: error.message }],
  });
}

// A lock's Database must stay reachable: collecting it would close the connection and release it.
const held = new Set<Database>();

function holderInfo(path: string): { pid: number | null; command: string | null } {
  try {
    const info: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isPlainObject(info)) {
      return {
        pid: typeof info.pid === "number" ? info.pid : null,
        command: typeof info.command === "string" ? info.command : null,
      };
    }
  } catch {
    // Not written yet, or gone: the holder is unknown.
  }
  return { pid: null, command: null };
}

/**
 * Takes the lock named `key` for this process, or throws LockedError naming its holder. The lock
 * is SQLite's exclusive lock on a file in `<home>/locks/`, which the OS drops when the process
 * dies, so a crash never leaves a stale lock. Call the returned function to release it.
 */
export function acquireLock(key: string, command: string): () => void {
  const dir = join(dataHome(), "locks");
  mkdirSync(dir, { recursive: true });
  const name = createHash("sha1").update(key, "utf8").digest("hex").slice(0, 12);
  const infoPath = join(dir, `${name}.info`);
  const db = new Database(join(dir, `${name}.lock`), { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if ((error as { code?: unknown }).code !== "SQLITE_BUSY") throw error;
    const holder = holderInfo(infoPath);
    const colon = key.indexOf(":");
    throw new LockedError(holder.command ?? command, key.slice(colon + 1), holder.pid);
  }
  held.add(db);
  writeFileSync(
    infoPath,
    JSON.stringify({ pid: process.pid, command, key, start: new Date().toISOString() }),
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // While the lock is still held, so it can't remove the next holder's file.
    try {
      unlinkSync(infoPath);
    } catch {
      // Already gone.
    }
    db.exec("ROLLBACK");
    db.close();
    held.delete(db);
  };
}
