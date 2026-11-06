// The one way the local app writes a file: only under the data home, never into a persona template
// (templates are published), and atomically, through a temp file in the same folder and a rename.
// The input rules for anything a request names on disk live here too.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dataHome, personaHomeDir, personaTemplateDir, templatesDir } from "@eidolon/config";

export class WriteRefused extends Error {
  override readonly name = "WriteRefused";
}

/** `path` is `root` or lies inside it; both absolute. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The data home, made private to this user when this creates it. */
export function ensureDataHome(): string {
  const home = dataHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

/** `path` with the part that exists resolved through symlinks, and the rest as written. */
function realish(path: string): string {
  const tail: string[] = [];
  let at = resolve(path);
  while (!existsSync(at) && dirname(at) !== at) {
    tail.unshift(basename(at));
    at = dirname(at);
  }
  try {
    at = realpathSync(at);
  } catch {
    // A dangling link or a race: compare it as written.
  }
  return join(at, ...tail);
}

function refuse(target: string): void {
  const folder = realish(dirname(target));
  if (!isInside(folder, realish(dataHome()))) {
    throw new WriteRefused(`${target} is outside the data home`);
  }
  if (isInside(folder, realish(templatesDir()))) {
    throw new WriteRefused(`${target} is in a persona template`);
  }
}

export interface WriteOptions {
  /** Readable by this user only: credentials, the local token. */
  readonly secret?: boolean;
}

/**
 * Replaces `target`, which must lie under the data home and outside the persona templates, with
 * `data`. A secret is created mode 0600 from its first byte, never chmodded afterwards.
 */
export function writeDataFile(
  target: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
): void {
  const path = resolve(target);
  // Before mkdir as well as after: a symlink inside the data home must not lead it to create
  // folders anywhere else.
  refuse(path);
  ensureDataHome();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  refuse(path);
  const folder = realpathSync(dirname(path));

  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const temp = join(folder, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", options.secret ? 0o600 : 0o644);
  let open = true;
  try {
    for (let written = 0; written < bytes.byteLength; ) {
      written += writeSync(fd, bytes, written, bytes.byteLength - written);
    }
    fsyncSync(fd);
    closeSync(fd);
    open = false;
    renameSync(temp, join(folder, basename(path)));
  } catch (error) {
    if (open) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Where every write to persona `id`'s `rel` goes: the user's copy in the data home. */
export function personaWriteTarget(id: string, rel: string): string {
  const own = personaHomeDir(id);
  const target = resolve(own, rel);
  if (!isInside(target, own) || target === own) {
    throw new WriteRefused(`${rel} is outside persona ${id}'s folder`);
  }
  return target;
}

/**
 * What a write to persona `id`'s `rel` starts from: the user's copy, else the template's, which the
 * write then copies into the data home; null when neither exists.
 */
export function readPersonaFile(id: string, rel: string): string | null {
  for (const root of [personaHomeDir(id), personaTemplateDir(id)]) {
    const path = resolve(root, rel);
    if (!isInside(path, root)) return null;
    try {
      return readFileSync(path, "utf8");
    } catch {
      // Not in this layer.
    }
  }
  return null;
}

/** Rewrites persona `id`'s `rel` in the user's copy, from the template's text on the first write. */
export function updatePersonaFile(
  id: string,
  rel: string,
  update: (current: string | null) => string,
): string {
  const target = personaWriteTarget(id, rel);
  writeDataFile(target, update(readPersonaFile(id, rel)));
  return target;
}

/** A persona id: a slug, because it becomes a folder name, a lock key and `--persona`. */
export const PERSONA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isPersonaId(value: unknown): value is string {
  return typeof value === "string" && PERSONA_ID.test(value);
}

// One path segment: no separator, drive colon or control character.
const FILE_NAME = /^[^/\\:\p{Cc}]{1,128}$/u;

/**
 * A file name a request names, NFC-normalized, or null: one segment, no leading dot, and one of
 * `extensions` (lowercase, with the dot) as its extension.
 */
export function checkFileName(raw: string, extensions: readonly string[]): string | null {
  const name = raw.normalize("NFC");
  if (!FILE_NAME.test(name) || name.startsWith(".")) return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !extensions.includes(name.slice(dot).toLowerCase())) return null;
  return name;
}

/** `name` in `folder`, refused unless it names a file directly in the folder. */
export function fileIn(folder: string, name: string): string {
  const root = resolve(folder);
  const target = resolve(root, name);
  if (dirname(target) !== root) throw new WriteRefused(`${name} is not a file in ${folder}`);
  return target;
}
