// The node shim's .cmd launchers (apps/desktop/node-shim) on Windows, for real: each through cmd.exe,
// as a shell or cross-spawn runs a .cmd, with this Node as EIDOLON_NODE, on the checkout's pnpm and a
// PATH where only they offer node. launchers.test.ts runs the POSIX ones, and the packaged smoke both
// on the app's own binary. Windows only.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LAUNCHER_SOURCES, POSIX_LAUNCHERS } from "../scripts/node-shim.ts";
import { osVariables } from "../scripts/smoke/env.ts";
import {
  closedPort,
  nodesIn,
  scriptRun,
  systemFolders,
  withVariables,
} from "../scripts/smoke/packaged.ts";
import { BACKEND_RUNTIME_ARGS } from "../src/main/controller.ts";

const WINDOWS = process.platform === "win32";
/** pnpm dlx's first install of a package, on a cold CI runner. */
const TIMEOUT_MS = 120_000;

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line !== "");
}

// A skipped suite's body still runs to collect its tests: what touches the disk waits for beforeAll.
describe.runIf(WINDOWS)("the node shim's .cmd launchers, on this Node", () => {
  let scratch = "";
  /** A package whose command prints what it was given. */
  let pkg = "";
  let env: Record<string, string> = {};

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "eidolon-node-shim-cmd-"));
    const home = join(scratch, "home");
    // pnpm dlx takes the realpath of os.homedir(), USERPROFILE here, and fails on one that's missing.
    mkdirSync(home);
    pkg = join(scratch, "hello");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "eidolon-shim-hello", version: "1.0.0", bin: "bin/hello.js" }),
    );
    writeFileSync(
      join(pkg, "bin", "hello.js"),
      "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    // The OS's own variables, as the packaged smoke runs them, and none of this run's.
    env = withVariables(
      osVariables(process.env, "win32"),
      {
        PATH: [...systemFolders("win32", process.env), LAUNCHER_SOURCES].join(";"),
        // pnpm's store and caches, under LOCALAPPDATA on Windows.
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, "AppData", "Local"),
        APPDATA: join(home, "AppData", "Roaming"),
        EIDOLON_NODE: process.execPath,
        // A file: package needs no registry; one pnpm tried anyway would fail at once, not after
        // the 70 s its retries take.
        pnpm_config_registry: `http://127.0.0.1:${await closedPort()}/`,
        pnpm_config_fetch_retries: "0",
      },
      "win32",
    );
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** cmd.exe running launcher `name` with `args`, as a terminal does. */
  function run(
    name: string,
    args: readonly string[],
    vars: Record<string, string> = env,
  ): SpawnSyncReturns<string> {
    const launcher = scriptRun(
      join(LAUNCHER_SOURCES, `${name}.cmd`),
      args,
      "win32",
      process.env.ComSpec,
    );
    return spawnSync(launcher.command, launcher.args, {
      cwd: scratch,
      encoding: "utf8",
      env: vars,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      windowsVerbatimArguments: launcher.windowsVerbatimArguments,
    });
  }

  test("the PATH they run on offers no node but theirs", () => {
    expect(nodesIn(systemFolders("win32", process.env), "win32")).toEqual([]);
  });

  test(
    "node runs EIDOLON_NODE as Node, with the backend's runtime flags",
    () => {
      const ran = run("node", [
        "-p",
        "JSON.stringify([process.execPath, process.execArgv, process.env.ELECTRON_RUN_AS_NODE])",
      ]);
      expect([ran.status, ran.stderr]).toEqual([0, ""]);
      const [execPath, execArgv, runAsNode] = JSON.parse(ran.stdout);
      expect([execPath.toLowerCase(), execArgv, runAsNode]).toEqual([
        process.execPath.toLowerCase(),
        [...BACKEND_RUNTIME_ARGS],
        "1",
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    "pnpm and pnpx run the checkout's pnpm, at apps/desktop's pin",
    () => {
      const { devDependencies } = JSON.parse(
        readFileSync(join(LAUNCHER_SOURCES, "..", "package.json"), "utf8"),
      );
      const pnpm = run("pnpm", ["--version"]);
      expect([pnpm.status, lines(pnpm.stdout)], pnpm.stderr).toEqual([0, [devDependencies.pnpm]]);
      const pnpx = run("pnpx", [`file:${pkg}`, "x"]);
      expect([pnpx.status, lines(pnpx.stdout)], pnpx.stderr).toEqual([0, ['["x"]']]);
    },
    TIMEOUT_MS,
  );

  test(
    "npx runs a package's command through pnpm dlx, the command's output alone on stdout",
    () => {
      const ran = run("npx", ["-y", `file:${pkg}`, "--flag", "two words"]);
      expect([ran.status, lines(ran.stdout)], ran.stderr).toEqual([0, ['["--flag","two words"]']]);
    },
    TIMEOUT_MS,
  );

  test(
    "each refuses to run without EIDOLON_NODE, saying why",
    () => {
      const { EIDOLON_NODE: _, ...unnamed } = env;
      for (const name of POSIX_LAUNCHERS) {
        const ran = run(name, ["--version"], unnamed);
        expect([
          name,
          ran.status,
          ran.stdout,
          lines(ran.stderr).map((line) => line.trim()),
        ]).toEqual([
          name,
          1,
          "",
          [`${name}: EIDOLON_NODE isn't set: Eidolon sets it for the MCP servers it starts`],
        ]);
      }
    },
    TIMEOUT_MS,
  );
});
