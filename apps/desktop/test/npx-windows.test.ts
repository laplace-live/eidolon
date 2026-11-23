// npx.cmd on Windows, for real, with this Node as EIDOLON_NODE: a local bin in a node_modules/.bin
// above the working folder, as a cmd-shim like npm's and as an .exe (a copy of this Node), and a
// folder pnpm links and gives a .cmd of its own, each given words cmd.exe treats specially, under
// a path with a space in it. Windows only.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LAUNCHER_SOURCES } from "../scripts/node-shim.ts";

const WINDOWS = process.platform === "win32";
type CmdLine = (
  comspec: string,
  file: string,
  args: readonly string[],
  doubleEscape: boolean,
) => { command: string; args: string[] };
const { cmdLine }: { cmdLine: CmdLine } = await import(
  pathToFileURL(join(LAUNCHER_SOURCES, "cross-spawn.mjs")).href
);

const AWKWARD = [
  "a b",
  'say "hi"',
  "&",
  "^",
  "100%",
  "%PATH%",
  "!x!",
  "",
  "C:\\dir\\",
  "C:\\dir\\\\",
  'a\\\\"b',
  "(x)",
  "<|>",
];
// A command printing what it was given and the folder it runs in.
const PRINT = "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n";

describe.runIf(WINDOWS)("npx.cmd", () => {
  let root = "";
  let cwd = "";
  let home = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "eidolon npx "));
    const bin = join(root, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(root, "tool"));
    writeFileSync(join(root, "tool", "cli.js"), PRINT);
    // npm finds a bin by the extension-less name npm and pnpm write beside the .cmd.
    writeFileSync(join(bin, "eidolon-cmd-tool"), "#!/bin/sh\n");
    writeFileSync(
      join(bin, "eidolon-cmd-tool.cmd"),
      `@"${process.execPath}" "%~dp0\\..\\..\\tool\\cli.js" %*\r\n`,
    );
    writeFileSync(join(bin, "eidolon-exe-tool"), "#!/bin/sh\n");
    copyFileSync(process.execPath, join(bin, "eidolon-exe-tool.exe"));
    writeFileSync(join(bin, "eidolon-exit-tool"), "#!/bin/sh\n");
    writeFileSync(join(bin, "eidolon-exit-tool.cmd"), "@exit /b 3\r\n");
    mkdirSync(join(root, "pkg", "bin"), { recursive: true });
    writeFileSync(
      join(root, "pkg", "package.json"),
      JSON.stringify({ name: "eidolon-npx-pkg", version: "1.0.0", bin: "bin/cli.js" }),
    );
    writeFileSync(join(root, "pkg", "bin", "cli.js"), `#!/usr/bin/env node\n${PRINT}`);
    cwd = join(root, "sub");
    mkdirSync(cwd);
    home = join(root, "home");
    mkdirSync(home);
  }, 120_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  /** What PRINT printed, its folder as the file system names it. */
  function printed(stdout: string) {
    const { argv, cwd: folder } = JSON.parse(stdout);
    return { argv, cwd: realpathSync.native(folder) };
  }

  /**
   * npx.cmd with `args` through cmd.exe, escaped twice as cross-spawn escapes a cmd-shim's, so each
   * word reaches npx whole; the backend's cross-spawn escapes npx.cmd's once. pnpm's caches in `home`.
   */
  function npx(args: readonly string[]) {
    const line = cmdLine(
      process.env.ComSpec ?? "cmd.exe",
      join(LAUNCHER_SOURCES, "npx.cmd"),
      args,
      true,
    );
    return spawnSync(line.command, line.args, {
      cwd,
      encoding: "utf8",
      timeout: 90_000,
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: {
        ...process.env,
        EIDOLON_NODE: process.execPath,
        LOCALAPPDATA: home,
        APPDATA: home,
        NODE_OPTIONS: undefined,
      },
    });
  }

  test("runs a local .cmd bin from the working folder, every word as it was given", () => {
    const ran = npx(["eidolon-cmd-tool", ...AWKWARD]);
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    expect(printed(ran.stdout)).toEqual({ argv: AWKWARD, cwd: realpathSync.native(cwd) });
  });

  test("runs a local .exe bin itself, with the same words", () => {
    const ran = npx([
      "eidolon-exe-tool",
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)))",
      ...AWKWARD,
    ]);
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    expect(JSON.parse(ran.stdout)).toEqual(AWKWARD);
  });

  test("ends with the bin's exit code", () => {
    expect(npx(["eidolon-exit-tool"]).status).toBe(3);
  });

  test("runs a folder's bin through the .cmd pnpm links for it, with the same words", () => {
    const ran = npx(["-y", join(root, "pkg"), ...AWKWARD]);
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    expect(printed(ran.stdout)).toEqual({ argv: AWKWARD, cwd: realpathSync.native(cwd) });
  }, 120_000);
});
