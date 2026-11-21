// `node apps/desktop/scripts/test-on-electron.ts [paths] [vitest flags]`: the backend's tests, the
// `node` project, on the Node inside apps/desktop's Electron, which runs the desktop app's backend
// and its jobs. Each Electron bump moves that Node and its V8, so the suite runs on it again.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");

// Required from Node, `electron` is the path to the binary it downloads on first use.
const electron: unknown = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") throw new Error("electron didn't resolve to its binary");
const vitest = spawnSync(
  electron,
  [
    join(ROOT, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--project",
    "node",
    ...process.argv.slice(2),
  ],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
);
process.exit(vitest.status ?? 1);
