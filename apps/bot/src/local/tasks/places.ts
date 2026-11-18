// Where a task's paths lie on disk, and how two of them compare there.
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isInside } from "@eidolon/assistant";

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
