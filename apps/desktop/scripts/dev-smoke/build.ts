// What the unpackaged app runs on, built afresh before each dev smoke unless it's told not to:
// apps/web/dist, which its backend serves from the checkout, and apps/desktop/dist's main, preload
// and shell pages, as `pnpm build:web` and `pnpm build:desktop` build them. The backend's
// stage isn't one of them: unpackaged, the backend runs from source.
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { build } from "vite";
import { DESKTOP, ROOT } from "../smoke/kit.ts";
import { mainBundle, preloadBundle, shellPages } from "../vite-common.ts";

const WEB = resolve(DESKTOP, "../web");

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
