// A temporary folder for the file tools' tests, and a guard that allows nothing outside it.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { TaskToolContext } from "@eidolon/engine";
import { resolveToCwd } from "../src/tools/path.ts";
import { type PathGuard, PathRefused } from "../src/types.ts";

const folders: string[] = [];

/** A new temporary folder, as its realpath; removeTempFolders deletes it. */
export async function tempFolder(): Promise<string> {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "eidolon-assistant-tools-")));
  folders.push(folder);
  return folder;
}

export async function removeTempFolders(): Promise<void> {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * A guard allowing `folder` alone, both ways, with every path under `denied` refused as
 * FolderPolicy's deny list refuses it; `resolved` collects each path it was asked about.
 */
export function folderGuard(
  folder: string,
  denied: readonly string[] = [],
): PathGuard & { readonly resolved: string[] } {
  const resolved: string[] = [];
  return {
    folder,
    resolved,
    async resolve(path, access) {
      resolved.push(path);
      const absolute = resolveToCwd(path, folder);
      if (denied.some((root) => isInside(absolute, root))) {
        throw new PathRefused(absolute, access, "denied");
      }
      if (!isInside(absolute, folder)) throw new PathRefused(absolute, access, "outside");
      return absolute;
    },
  };
}

/** A context whose signal is `signal`, or one that never aborts. */
export function toolContext(signal = new AbortController().signal): TaskToolContext {
  return { signal, onUpdate() {} };
}
