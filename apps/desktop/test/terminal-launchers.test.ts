// The eidolon command's launchers, which electron-builder ships into the app's resources/bin: what
// they run, and the macOS one run for real against a stand-in bundle through links. The Windows one
// runs in terminal-command-windows.test.ts.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { BACKEND_RUNTIME_ARGS } from "../src/main/controller.ts";

const DESKTOP = resolve(import.meta.dirname, "..");
const MAC_LAUNCHER = join(DESKTOP, "launchers", "mac", "eidolon");
const WIN_LAUNCHER = join(DESKTOP, "launchers", "win", "eidolon.cmd");
const POSIX = process.platform !== "win32";

const scratch = mkdtempSync(join(tmpdir(), "eidolon-terminal-launchers-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function folder(name: string): string {
  return mkdtempSync(join(scratch, `${name}-`));
}

describe("the launchers", () => {
  test("run the CLI with the backend's runtime flags before it", () => {
    for (const file of [MAC_LAUNCHER, WIN_LAUNCHER]) {
      const text = readFileSync(file, "utf8");
      const flags = /Eidolon(?:\.exe)?" (.*?) "[^"]*cli\.js"/.exec(text)?.[1];
      expect([file, flags?.split(" ")]).toEqual([file, [...BACKEND_RUNTIME_ARGS]]);
    }
  });

  test("electron-builder ships each platform's launcher, alone, into the app's resources/bin", async () => {
    const builder = createRequire(join(DESKTOP, "package.json")).resolve(
      "electron-builder/package.json",
    );
    const { getConfig } = createRequire(builder)("app-builder-lib/out/util/config/config.js");
    const config = await getConfig(DESKTOP, "electron-builder.yml", null);
    expect(config.mac.extraResources).toContainEqual({ from: "launchers/mac", to: "bin" });
    expect(config.win.extraResources).toContainEqual({ from: "launchers/win", to: "bin" });
    expect(readdirSync(dirname(MAC_LAUNCHER))).toEqual(["eidolon"]);
    expect(readdirSync(dirname(WIN_LAUNCHER))).toEqual(["eidolon.cmd"]);
  });

  test("the Windows one has CRLF line ends, which cmd.exe reads safely", () => {
    const text = readFileSync(WIN_LAUNCHER, "utf8");
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });

  test.skipIf(!POSIX)("the macOS one is executable", () => {
    expect(statSync(MAC_LAUNCHER).mode & 0o100).toBe(0o100);
  });
});

// A stand-in for the app: its binary prints what it got, and `open` on PATH does the same.
describe.skipIf(!POSIX)("the macOS launcher, through links to a stand-in bundle", () => {
  const FAKE_BINARY = [
    "#!/bin/sh",
    "printf 'ELECTRON_RUN_AS_NODE=%s\\n' \"$ELECTRON_RUN_AS_NODE\"",
    "printf 'EIDOLON_APP_ROOT=%s\\n' \"$EIDOLON_APP_ROOT\"",
    "printf 'EIDOLON_NO_DOTENV=%s\\n' \"$EIDOLON_NO_DOTENV\"",
    "printf 'EIDOLON_HOME=%s\\n' \"$EIDOLON_HOME\"",
    'for arg in "$0" "$@"; do printf \'arg=%s\\n\' "$arg"; done',
    'for arg in "$@"; do last=$arg; done',
    '[ "$last" = exit-7 ] && exit 7',
    "exit 0",
    "",
  ].join("\n");
  const FAKE_OPEN = [
    "#!/bin/sh",
    'for arg in "$@"; do printf \'open=%s\\n\' "$arg"; done',
    "",
  ].join("\n");

  function standIn() {
    const root = folder("bundle");
    const bundle = join(root, "Eidolon.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(bundle, "Contents", "Resources", "bin"), { recursive: true });
    writeFileSync(join(bundle, "Contents", "MacOS", "Eidolon"), FAKE_BINARY, { mode: 0o755 });
    const launcher = join(bundle, "Contents", "Resources", "bin", "eidolon");
    copyFileSync(MAC_LAUNCHER, launcher);
    chmodSync(launcher, 0o755);
    // As Install links it, then a relative link to that link.
    mkdirSync(join(root, "usr-local-bin"));
    symlinkSync(launcher, join(root, "usr-local-bin", "eidolon"));
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join("..", "usr-local-bin", "eidolon"), join(root, "elsewhere", "eidolon"));
    mkdirSync(join(root, "fake-bin"));
    writeFileSync(join(root, "fake-bin", "open"), FAKE_OPEN, { mode: 0o755 });
    return { root, bundle: realpathSync(bundle), launcher };
  }

  function lines(stdout: string) {
    const all = stdout.split("\n").filter((line) => line !== "");
    const env = Object.fromEntries(
      all.filter((line) => !line.startsWith("arg=")).map((line) => line.split(/=(.*)/s, 2)),
    );
    const args = all.filter((line) => line.startsWith("arg=")).map((line) => line.slice(4));
    return { env, args };
  }

  test("with arguments, runs the bundle's binary as Node on the CLI, with them, exiting as it does", () => {
    const { root, bundle, launcher } = standIn();
    const args = ["search", "--help", "two words", "it's $HOME"];
    for (const command of [join(root, "elsewhere", "eidolon"), launcher]) {
      const run = spawnSync(command, args, {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", EIDOLON_HOME: "/tmp/a home" },
      });
      expect([command, run.status, run.stderr]).toEqual([command, 0, ""]);
      expect(lines(run.stdout)).toEqual({
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          EIDOLON_APP_ROOT: `${bundle}/Contents/Resources/eidolon`,
          EIDOLON_NO_DOTENV: "1",
          EIDOLON_HOME: "/tmp/a home",
        },
        args: [
          `${bundle}/Contents/MacOS/Eidolon`,
          ...BACKEND_RUNTIME_ARGS,
          `${bundle}/Contents/Resources/eidolon/dist/cli.js`,
          ...args,
        ],
      });
    }
    const failed = spawnSync(join(root, "elsewhere", "eidolon"), ["search", "exit-7"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(failed.status).toBe(7);
  });

  test("with none, opens the bundle and runs nothing else", () => {
    const { root, bundle } = standIn();
    const run = spawnSync(join(root, "elsewhere", "eidolon"), [], {
      encoding: "utf8",
      env: { PATH: `${join(root, "fake-bin")}:/usr/bin:/bin`, ELECTRON_RUN_AS_NODE: "1" },
    });
    expect([run.status, run.stderr, run.stdout]).toEqual([0, "", `open=${bundle}\n`]);
  });
});
