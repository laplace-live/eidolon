import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** The repository root, where Python's `PROJECT_ROOT` points. The Docker image keeps this layout. */
export const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

/** `PROJECT_ROOT / value`, as pathlib joins: an absolute `value` stands alone. */
export function resolveProjectPath(value: string): string {
  return isAbsolute(value) ? value : join(PROJECT_ROOT, value);
}

/**
 * A file the code ships with: `packaged` under `EIDOLON_APP_ROOT`, which the npm package's launcher
 * sets to the package, else `inCheckout` under this checkout. Every module of a bundle has dist/
 * as its `import.meta.dir`, so a lookup relative to the code would break there.
 */
export function shippedPath(packaged: string, inCheckout: string): string {
  const root = process.env.EIDOLON_APP_ROOT;
  return root ? join(root, packaged) : join(PROJECT_ROOT, inCheckout);
}

/** The built web app the local server serves. */
export function webDist(): string {
  return shippedPath("web", "apps/web/dist");
}

/** The local web app's server, which its supervisor runs. */
export function serverEntry(): string {
  return shippedPath("dist/server.js", "apps/bot/src/local/server.ts");
}

/** The offline chain's CLI, which a job runs. */
export function cliEntry(): string {
  return shippedPath("dist/cli.js", "apps/cli/src/main.ts");
}

/** jieba's dictionary and HMM tables. */
export function jiebaDir(): string {
  return shippedPath("data/jieba", "packages/retrieval/data/jieba");
}

/** `os.path.expanduser` for the current user's `~`. */
export function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
