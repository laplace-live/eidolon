// Where a task's paths lie on disk, and how two of them compare there.
import { readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { isInside } from "@eidolon/assistant";

/**
 * Where `path` lies on disk: its realpath, or its deepest existing folder's plus the rest, a
 * dangling link followed to where a write through it lands, as FolderPolicy follows one.
 */
export async function placeOf(path: string): Promise<string> {
  let missing: boolean;
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    missing = code === "ENOENT" || code === "ENOTDIR";
  }
  const parent = dirname(path);
  if (parent === path) return path;
  const here = join(await placeOf(parent), basename(path));
  if (!missing) return here;
  const target = await readlink(here).catch(() => null);
  if (target === null) return here;
  const leads = await linkTarget(dirname(here), target).catch(() => null);
  return leads === null ? here : placeOf(leads);
}

/** A link's `target`, read from `folder`, each `..` taken on disk as the kernel takes it. */
async function linkTarget(folder: string, target: string): Promise<string> {
  let at = isAbsolute(target) ? parse(target).root : folder;
  for (const part of target.split(sep)) {
    if (part === "" || part === ".") continue;
    at = part === ".." ? await realpath(`${at}${sep}..`) : join(at, part);
  }
  return at;
}

export async function insideAny(place: string, folders: readonly string[]): Promise<boolean> {
  for (const folder of folders) if (isInside(place, await placeOf(folder))) return true;
  return false;
}

/** `path` with `home`, the home folder, written as `~`. */
export function homed(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
