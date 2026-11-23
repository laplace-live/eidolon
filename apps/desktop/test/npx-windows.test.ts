// npx.cmd on Windows, for real, with this Node as EIDOLON_NODE: a local bin in a node_modules/.bin
// above the working folder, as a cmd-shim like npm's and as an .exe (a copy of this Node), and a
// folder pnpm links and gives a .cmd of its own, each given words cmd.exe treats specially, under
// a path with a space in it; then a folder's bin where only the shim offers node. Windows only, but
// for how many times cmd.exe reads the words npx starts a batch file with, which made-up shims and
// folders show on any OS.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LAUNCHER_SOURCES, POSIX_LAUNCHERS } from "../scripts/node-shim.ts";
import { osVariables } from "../scripts/smoke/env.ts";
import { closedPort, nodesIn, systemFolders, withVariables } from "../scripts/smoke/packaged.ts";

const WINDOWS = process.platform === "win32";
type Env = Record<string, string>;
interface CrossSpawn {
  escapeCommand(command: string): string;
  cmdLine(
    comspec: string,
    file: string,
    args: readonly string[],
    rereads: number,
  ): { command: string; args: string[] };
}
interface Npx {
  nodeCmdShim(text: string): { lessJs: boolean } | undefined;
  rereads(file: string, options: { env: Env; cwd: string; nodeCmd?: string }): number;
  spawnArgs(
    file: string,
    args: readonly string[],
    options: { platform: string; env: Env; cwd: string; nodeCmd?: string },
  ): { command: string; args: string[]; verbatim: boolean };
}
const { cmdLine, escapeCommand }: CrossSpawn = await import(
  pathToFileURL(join(LAUNCHER_SOURCES, "cross-spawn.mjs")).href
);
const npx: Npx = await import(pathToFileURL(join(LAUNCHER_SOURCES, "npx.mjs")).href);

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
// What cmd.exe acts on when it reads a word once more than it was escaped for: a quote in it ends
// the quoting that kept & | < > ^ ( ) from cmd.exe. The marker would show it ran one.
const ACTIVE = [
  '{"u":"h?a=1&b=2"}',
  '{"r":"^1.2.3"}',
  "(foo|bar>baz|foz)",
  'a"&b',
  'x"&echo pwned>marker.txt&"',
  'a\\"b',
];
// A command printing what it was given and the folder it runs in.
const PRINT = "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n";

/** What PRINT printed, its folder as the file system names it. */
function printed(stdout: string) {
  const { argv, cwd: folder } = JSON.parse(stdout);
  return { argv, cwd: realpathSync.native(folder) };
}

/** The cmd-shim pnpm writes for a bin `#!/usr/bin/env node` starts, at `target` from its folder. */
function pnpmShim(target: string): string {
  return [
    "@SETLOCAL",
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${target}" %*`,
    ")",
    "",
  ].join("\r\n");
}

/** The cmd-shim npm writes for it. */
function npmShim(target: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
    "",
  ].join("\r\n");
}

const TARGET = "..\\pkg\\bin\\cli.js";

describe("a cmd-shim that runs its bin on node, as npx reads one", () => {
  const crlf = (lines: readonly string[]) => lines.join("\r\n");
  const SHIMS: readonly (readonly [string, string, { lessJs: boolean } | undefined])[] = [
    ["pnpm's", pnpmShim(TARGET), { lessJs: true }],
    [
      "pnpm's, setting NODE_PATH and passing on its #! line's arguments",
      crlf([
        "@SETLOCAL",
        "@IF NOT DEFINED NODE_PATH (",
        '  @SET "NODE_PATH=C:\\dlx\\node_modules"',
        ") ELSE (",
        '  @SET "NODE_PATH=C:\\dlx\\node_modules;%NODE_PATH%"',
        ")",
        '@IF EXIST "%~dp0\\node.exe" (',
        `  "%~dp0\\node.exe" --harmony "%~dp0\\${TARGET}" %*`,
        ") ELSE (",
        "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
        `  node --harmony "%~dp0\\${TARGET}" %*`,
        ")",
        "",
      ]),
      { lessJs: true },
    ],
    [
      "pnpm's, in UTF-8's code page for a path that isn't ASCII",
      crlf([
        "@SETLOCAL",
        '@SET "_PNPM_CODEPAGE="',
        '@FOR /F "tokens=2 delims=:" %%a IN (\'"%SystemRoot%\\System32\\chcp.com"\') DO @SET "_PNPM_CODEPAGE=%%a"',
        '@"%SystemRoot%\\System32\\chcp.com" 65001 >NUL',
        '@SET "ERRORLEVEL="',
        pnpmShim("..\\pkg\\bin\\héllo.js").replace("@SETLOCAL\r\n", "").trimEnd(),
        '@SET "_PNPM_EXIT_CODE=%ERRORLEVEL%"',
        '@IF DEFINED _PNPM_CODEPAGE @"%SystemRoot%\\System32\\chcp.com" %_PNPM_CODEPAGE% >NUL',
        "@EXIT /B %_PNPM_EXIT_CODE%",
        "",
      ]),
      { lessJs: true },
    ],
    [
      "npm's before it set _prog",
      crlf([
        '@IF EXIST "%~dp0\\node.exe" (',
        `  "%~dp0\\node.exe"  "%~dp0\\${TARGET}" %*`,
        ") ELSE (",
        "  @SETLOCAL",
        "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
        `  node  "%~dp0\\${TARGET}" %*`,
        ")",
      ]),
      { lessJs: true },
    ],
    // Its endLocal has put PATHEXT back when the line runs node.
    ["npm's", npmShim(TARGET), { lessJs: false }],
    [
      "npm's first to set _prog, which runs node before its ENDLOCAL",
      npmShim(TARGET)
        .replace("endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ", "")
        .concat("ENDLOCAL\r\nEXIT /b %errorlevel%\r\n"),
      { lessJs: true },
    ],
    [
      "none: pnpm's for a node it names",
      crlf(["@SETLOCAL", `@"C:\\node\\node.exe"  "%~dp0\\${TARGET}" %*`, ""]),
      undefined,
    ],
    [
      "none: pnpm's for a program",
      crlf(["@SETLOCAL", '@"%~dp0\\..\\pkg\\tool.exe"   %*', ""]),
      undefined,
    ],
    [
      "none: pnpm's for sh",
      pnpmShim(TARGET).replaceAll("node.exe", "sh.exe").replace("  node  ", "  sh  "),
      undefined,
    ],
    ...POSIX_LAUNCHERS.map(
      (name) =>
        [
          `none: the shim's ${name}.cmd`,
          readFileSync(join(LAUNCHER_SOURCES, `${name}.cmd`), "latin1"),
          undefined,
        ] as const,
    ),
  ];

  test.each(SHIMS)("%s", (_, text, expected) => {
    expect(npx.nodeCmdShim(text)).toEqual(expected);
  });
});

describe("how many times cmd.exe reads the words npx starts a batch file with", () => {
  // Windows' rules on made-up folders, on any OS: nothing runs.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "eidolon-npx-reads-")));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const put = (file: string, text = "") => {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), text);
    return join(base, file);
  };
  // Stands in for the shim's node.cmd, which hands its words on through %*.
  const nodeCmd = put("shim/node.cmd", "@echo off\r\n");
  const pnpm = put("bin/pnpm-tool.cmd", pnpmShim(TARGET));
  const npm = put("bin/npm-tool.cmd", npmShim(TARGET));
  const plain = put("bin/plain.cmd", '@echo off\r\n"%~dp0\\tool.exe" %*\r\n');
  const script = put("bin/tool.js");
  const beside = put("beside/tool.cmd", pnpmShim(TARGET));
  put("beside/node.exe");
  put("other/node.exe");
  put("js/node.js");
  put("here/node.cmd");
  const empty = join(base, "empty");
  mkdirSync(empty);
  // In lower case, so that a file system with case finds the made-up files as NTFS would.
  const PATHEXT = ".com;.exe;.bat;.cmd;.vbs;.vbe;.js;.jse;.wsf;.wsh;.msc";
  const envOf = (dirs: readonly string[], more: Env = {}): Env => ({
    PATH: dirs.map((dir) => join(base, dir)).join(";"),
    PATHEXT,
    ...more,
  });
  const reads = (file: string, dirs: readonly string[], cwd = empty, more: Env = {}) =>
    npx.rereads(file, { env: envOf(dirs, more), cwd, nodeCmd }) + 1;

  test("three for a cmd-shim, pnpm's or npm's, whose node is the shim's node.cmd, each word escaped for each", () => {
    expect([reads(pnpm, ["bin", "shim"]), reads(npm, ["bin", "shim"])]).toEqual([3, 3]);
    const env = { ...envOf(["bin", "shim"]), ComSpec: "C:\\cmd.exe" };
    expect(npx.spawnArgs(pnpm, ["&", ""], { platform: "win32", env, cwd: empty, nodeCmd })).toEqual(
      {
        command: "C:\\cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          `"${escapeCommand(pnpm)} ^^^^^^^"^^^^^^^&^^^^^^^" ^^^^^^^"^^^^^^^""`,
        ],
        verbatim: true,
      },
    );
  });

  test("two where cmd.exe runs another node: the node.exe beside it, or one before the shim's on PATH or in the working folder", () => {
    expect(reads(beside, ["beside", "shim"])).toBe(2);
    expect(reads(pnpm, ["other", "shim"])).toBe(2);
    const here = join(base, "here");
    expect(reads(pnpm, ["bin", "shim"], here)).toBe(2);
    // Unless cmd.exe is told to look on PATH alone.
    const alone = { NoDefaultCurrentDirectoryInExePath: "1" };
    expect(reads(pnpm, ["bin", "shim"], here, alone)).toBe(3);
  });

  test("a node.js before the shim's node.cmd: run for npm's shim, which puts .JS back in PATHEXT first, not pnpm's", () => {
    expect([reads(pnpm, ["js", "shim"]), reads(npm, ["js", "shim"])]).toEqual([3, 2]);
  });

  test("two for any other batch file, as npm counts, and one for a file cmd.exe runs as it is", () => {
    expect(reads(plain, ["bin", "shim"])).toBe(2);
    expect(reads(pnpm, ["bin"])).toBe(2);
    expect(reads(join(base, "bin", "missing.cmd"), ["bin", "shim"])).toBe(2);
    expect(reads(script, ["bin", "shim"])).toBe(1);
  });
});

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

  /**
   * npx.cmd with `args` through cmd.exe, escaped twice as cross-spawn escapes a cmd-shim's, so each
   * word reaches npx whole. pnpm's caches in `home`.
   */
  function npx(args: readonly string[]) {
    const line = cmdLine(
      process.env.ComSpec ?? "cmd.exe",
      join(LAUNCHER_SOURCES, "npx.cmd"),
      args,
      1,
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

  // The PATH has a node.exe, which pnpm's cmd-shim runs: cmd.exe reads the words twice.
  test("runs a folder's bin through the .cmd pnpm links for it, with the same words", () => {
    const ran = npx(["-y", join(root, "pkg"), ...AWKWARD]);
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    expect(printed(ran.stdout)).toEqual({ argv: AWKWARD, cwd: realpathSync.native(cwd) });
  }, 120_000);
});

describe.runIf(WINDOWS)("npx.cmd where only the shim offers node", () => {
  let root = "";
  let cwd = "";
  let env: Env = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "eidolon npx shim "));
    const home = join(root, "home");
    mkdirSync(home);
    mkdirSync(join(root, "words", "bin"), { recursive: true });
    writeFileSync(
      join(root, "words", "package.json"),
      JSON.stringify({
        name: "eidolon-npx-words",
        version: "1.0.0",
        bin: { "eidolon-words": "bin/cli.js" },
      }),
    );
    writeFileSync(join(root, "words", "bin", "cli.js"), `#!/usr/bin/env node\n${PRINT}`);
    cwd = join(root, "sub");
    mkdirSync(cwd);
    // A folder needs no registry; one pnpm tried anyway would fail at once, not after its retries.
    const registry = `http://127.0.0.1:${await closedPort()}/`;
    writeFileSync(join(home, ".npmrc"), `registry=${registry}\n`);
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
        pnpm_config_registry: registry,
        pnpm_config_fetch_retries: "0",
      },
      "win32",
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  test("the PATH it runs on offers no node but the shim's", () => {
    expect(nodesIn(systemFolders("win32", process.env), "win32")).toEqual([]);
  });

  // cmd.exe reads the words three times: npx's line, the cmd-shim's %* and node.cmd's.
  test("runs a folder's bin through pnpm's cmd-shim and the shim's node.cmd, every word as it was given, none run", () => {
    const words = [...AWKWARD, ...ACTIVE];
    const line = cmdLine(
      process.env.ComSpec ?? "cmd.exe",
      join(LAUNCHER_SOURCES, "npx.cmd"),
      ["-y", "-p", join(root, "words"), "eidolon-words", ...words],
      1,
    );
    const ran = spawnSync(line.command, line.args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      windowsVerbatimArguments: true,
      env,
    });
    expect([ran.status, existsSync(join(cwd, "marker.txt"))], ran.stderr).toEqual([0, false]);
    expect(printed(ran.stdout)).toEqual({ argv: words, cwd: realpathSync.native(cwd) });
  }, 120_000);
});
