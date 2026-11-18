// Where a task's paths lie on disk, and how two of them compare there.
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

// APFS and NTFS match names in any case.
const fold =
  process.platform === "darwin" || process.platform === "win32"
    ? (path: string) => path.toLowerCase()
    : (path: string) => path;

export function isInside(path: string, root: string): boolean {
  const rel = relative(fold(root), fold(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Where `path` lies on disk: its realpath, or its deepest existing folder's plus the rest. */
export async function placeOf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await placeOf(parent), basename(path));
  }
}

export async function insideAny(place: string, folders: readonly string[]): Promise<boolean> {
  for (const folder of folders) if (isInside(place, await placeOf(folder))) return true;
  return false;
}
