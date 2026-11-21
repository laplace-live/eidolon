// What the unpackaged app runs on, built afresh before each dev smoke unless it's told not to:
// apps/web/dist, which its backend serves from the checkout, and apps/desktop/dist's main, preload
// and shell pages, as `bun run build:web` and `bun run build:desktop` build them. The backend's
// stage isn't one of them: unpackaged, the backend runs from source.
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import { mainBundle, preloadBundle, shellPages } from "../vite-common.ts";

const DESKTOP = resolve(import.meta.dirname, "../..");
const WEB = resolve(DESKTOP, "../web");
const ROOT = resolve(DESKTOP, "../..");

/** A file of each build, which a run without it can't start. */
const BUILT = [
  join(WEB, "dist", "index.html"),
  join(DESKTOP, "dist", "main", "index.js"),
  join(DESKTOP, "dist", "preload", "index.cjs"),
  join(DESKTOP, "dist", "shell", "loading.html"),
];

/** Builds the web app, then main, the preload and the shell pages. */
export async function buildApp(): Promise<void> {
  await build({
    root: WEB,
    configFile: join(WEB, "vite.config.ts"),
    envDir: false,
    logLevel: "warn",
  });
  for (const config of [mainBundle(), preloadBundle(), shellPages()]) await build(config);
}

/** The builds' files that are missing, relative to the checkout. */
export function missingBuilds(): string[] {
  return BUILT.filter((file) => !existsSync(file)).map((file) => relative(ROOT, file));
}
