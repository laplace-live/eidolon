// `bun run dev:desktop`: watch-builds main, the preload and the shell pages, serves apps/web from
// Vite's dev server on 127.0.0.1:5173, and runs the unpackaged app. Arguments after it go to Electron,
// such as `--user-data-dir=<folder>` for a profile of its own.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { build, createServer, type InlineConfig, type Rolldown } from "vite";
import { electronEnv } from "./electron-env.ts";
import { mainBundle, preloadBundle, shellPages } from "./vite-common.ts";

const DESKTOP = resolve(import.meta.dirname, "..");
const WEB = resolve(DESKTOP, "../web");

/** A watch build, once its first bundle is written. */
async function watch(config: InlineConfig): Promise<Rolldown.RolldownWatcher> {
  const result = await build({ ...config, build: { ...config.build, watch: {} } });
  if (Array.isArray(result) || !("on" in result)) throw new Error("Vite returned no watcher");
  const watcher = result;
  await new Promise<void>((done, fail) => {
    const onEvent = (event: Rolldown.RolldownWatcherEvent): void => {
      if (event.code === "END") {
        watcher.off("event", onEvent);
        done();
      } else if (event.code === "ERROR") {
        watcher.off("event", onEvent);
        fail(new Error(event.error.message));
      }
    };
    watcher.on("event", onEvent);
  });
  return watcher;
}

const watchers = [
  await watch(mainBundle({ dev: true })),
  await watch(preloadBundle({ dev: true })),
  await watch(shellPages()),
];

// The page is at eidolon-app://app, so HMR's socket names the dev server's own address.
const web = await createServer({
  root: WEB,
  configFile: join(WEB, "vite.config.ts"),
  envDir: false,
  server: { ws: { protocol: "ws", host: "127.0.0.1", clientPort: 5173 } },
});
await web.listen();

// Required from Node, `electron` is the path to the binary it downloads on first use.
const electron: unknown = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") throw new Error("electron didn't resolve to its binary");
const app = spawn(electron, [DESKTOP, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: electronEnv(),
});
app.on("close", async (code) => {
  for (const watcher of watchers) await watcher.close();
  await web.close();
  process.exit(code ?? 0);
});
