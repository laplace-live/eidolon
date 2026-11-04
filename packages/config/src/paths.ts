import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** The repository root, where Python's `PROJECT_ROOT` points. The Docker image keeps this layout. */
export const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

/** `PROJECT_ROOT / value`, as pathlib joins: an absolute `value` stands alone. */
export function resolveProjectPath(value: string): string {
  return isAbsolute(value) ? value : join(PROJECT_ROOT, value);
}

/** `os.path.expanduser` for the current user's `~`. */
export function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
