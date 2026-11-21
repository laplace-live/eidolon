// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/tests/login-shell-environment.spec.ts@2e39e70496
//
// deepseek's merge, with Eidolon's own rules: the launch environment's EIDOLON_* names win, Windows
// reads and writes names in any case, and the backend runs as the app's Node on the payload and on
// main's data home.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  loginShellOff,
  mergeShellEnvironment,
  readEnvironment,
  startupEnvironment,
  withBackendVariables,
} from "../src/main/environment.ts";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eidolon-environment-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A stand-in login shell: `body` plays the rc files, then the dump runs under /bin/sh. */
function shell(name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n[ "$1" = -ilc ] || exit 64\n${body}\nexec /bin/sh -c "$2"\n`);
  chmodSync(path, 0o755);
  return path;
}

/** The keys of `env` that name `name` in any case. */
function spellings(env: NodeJS.ProcessEnv, name: string): string[] {
  return Object.keys(env).filter((key) => key.toUpperCase() === name);
}

describe("mergeShellEnvironment", () => {
  test("lets the shell's values win but the probe's own, ELECTRON_* and the launch's EIDOLON_*", () => {
    const launch = {
      PATH: "/usr/bin",
      HOME: "/Users/owner",
      PWD: "/",
      EIDOLON_HOME: "/tmp/smoke-home",
      EIDOLON_PERSONA: "",
    };
    const merged = mergeShellEnvironment(
      launch,
      {
        PATH: "/opt/homebrew/bin:/usr/bin",
        XDG_CACHE_HOME: "/cache",
        PWD: "/Users/owner",
        OLDPWD: "/",
        SHLVL: "2",
        _: "/usr/bin/env",
        DISABLE_AUTO_UPDATE: "true",
        ZSH_TMUX_AUTOSTARTED: "true",
        ZSH_TMUX_AUTOSTART: "false",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_ENABLE_LOGGING: "1",
        EIDOLON_HOME: "/Users/owner/eidolon",
        EIDOLON_PERSONA: "from-rc",
        EIDOLON_SHARED_SKILLS: "/Users/owner/skills",
      },
      "darwin",
    );
    expect(merged).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HOME: "/Users/owner",
      PWD: "/",
      XDG_CACHE_HOME: "/cache",
      // Set in the launch environment, as a smoke or a terminal sets it: the launch's holds.
      EIDOLON_HOME: "/tmp/smoke-home",
      // Blank there, which counts as unset: the shell's.
      EIDOLON_PERSONA: "from-rc",
      EIDOLON_SHARED_SKILLS: "/Users/owner/skills",
    });
    expect(launch.PATH).toBe("/usr/bin");
  });

  test("is case-sensitive outside Windows", () => {
    expect(
      mergeShellEnvironment({ Path: "/a" }, { PATH: "/b", electron_run_as_node: "1" }, "darwin"),
    ).toEqual({ Path: "/a", PATH: "/b", electron_run_as_node: "1" });
  });

  test("on Windows, reads and writes names in any case, with one PATH", () => {
    const launch = { Path: "C:\\Windows", Eidolon_Home: "C:\\smoke", SystemRoot: "C:\\Windows" };
    const merged = mergeShellEnvironment(
      launch,
      {
        PATH: "C:\\Tools;C:\\Windows",
        EIDOLON_HOME: "C:\\rc-home",
        electron_run_as_node: "1",
        pwd: "C:\\Users\\owner",
      },
      "win32",
    );
    expect(merged).toEqual({
      Path: "C:\\Tools;C:\\Windows",
      Eidolon_Home: "C:\\smoke",
      SystemRoot: "C:\\Windows",
    });
    expect(spellings(merged, "PATH")).toEqual(["Path"]);
  });
});

describe("withBackendVariables", () => {
  const home = "/Users/owner/.laplace/eidolon";

  test("runs the app's binary as Node on main's data home and the payload, with no .env", () => {
    const launch = { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "0", EIDOLON_HOME: "/from-rc" };
    expect(
      withBackendVariables(launch, { home, appRoot: "/Applications/Eidolon.app/x" }, "darwin"),
    ).toEqual({
      PATH: "/usr/bin",
      EIDOLON_HOME: home,
      EIDOLON_APP_ROOT: "/Applications/Eidolon.app/x",
      EIDOLON_NO_DOTENV: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(launch).toEqual({
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "0",
      EIDOLON_HOME: "/from-rc",
    });
  });

  test("leaves EIDOLON_APP_ROOT out for the dev backend, which finds its files in the checkout", () => {
    expect(
      withBackendVariables({ EIDOLON_APP_ROOT: "/stale" }, { home, appRoot: null }, "darwin"),
    ).toEqual({ EIDOLON_HOME: home, EIDOLON_NO_DOTENV: "1", ELECTRON_RUN_AS_NODE: "1" });
  });

  test("on Windows, starting from {Path: C:\\Windows}, writes each name once in any case", () => {
    const windowsHome = "C:\\Users\\owner\\.laplace\\eidolon";
    const payload = "C:\\Users\\owner\\AppData\\Local\\Programs\\eidolon\\resources\\eidolon";
    const env = withBackendVariables(
      {
        Path: "C:\\Windows",
        Eidolon_Home: "C:\\from-rc",
        eidolon_app_root: "C:\\old",
        Electron_Run_As_Node: "0",
        EIDOLON_NO_DOTENV: "0",
        eidolon_no_dotenv: "0",
      },
      { home: windowsHome, appRoot: payload },
      "win32",
    );
    expect(env).toEqual({
      Path: "C:\\Windows",
      Eidolon_Home: windowsHome,
      eidolon_app_root: payload,
      Electron_Run_As_Node: "1",
      EIDOLON_NO_DOTENV: "1",
    });
    expect(
      withBackendVariables(
        { Path: "C:\\Windows", eidolon_app_root: "x" },
        { home: windowsHome, appRoot: null },
        "win32",
      ),
    ).toEqual({
      Path: "C:\\Windows",
      EIDOLON_HOME: windowsHome,
      EIDOLON_NO_DOTENV: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  // The stand-in shell is a POSIX script.
  test.skipIf(process.platform === "win32")(
    "keeps a respawn on main's data home after the rc's EIDOLON_HOME moves",
    async () => {
      const exported = join(directory, "home");
      writeFileSync(exported, "/a");
      const login = shell("login", `export EIDOLON_HOME="$(cat '${exported}')"`);
      // A Finder launch, with no EIDOLON_HOME of its own: main's home comes from the rc's.
      const environment = await startupEnvironment(
        { PATH: "/usr/bin:/bin" },
        { platform: "darwin", shells: [login] },
      );
      const resolved = environment.env.EIDOLON_HOME as string;
      expect(resolved).toBe("/a");
      await environment.forSpawn();
      writeFileSync(exported, "/b");
      const respawn = await environment.forSpawn();
      expect(respawn.EIDOLON_HOME).toBe("/b");
      expect(
        withBackendVariables(respawn, { home: resolved, appRoot: null }, "darwin").EIDOLON_HOME,
      ).toBe("/a");
    },
  );
});

describe("loginShellOff", () => {
  test("only EIDOLON_DESKTOP_LOGIN_SHELL off in the launch environment turns the read off", () => {
    for (const value of ["0", "false", "OFF", " no "]) {
      expect(loginShellOff({ EIDOLON_DESKTOP_LOGIN_SHELL: value }, "darwin")).toBe(true);
    }
    for (const value of ["1", "", "yes"]) {
      expect(loginShellOff({ EIDOLON_DESKTOP_LOGIN_SHELL: value }, "darwin")).toBe(false);
    }
    expect(loginShellOff({}, "darwin")).toBe(false);
    expect(loginShellOff({ eidolon_desktop_login_shell: "0" }, "darwin")).toBe(false);
    expect(loginShellOff({ eidolon_desktop_login_shell: "0" }, "win32")).toBe(true);
  });
});

describe("readEnvironment", () => {
  test("on Windows, takes a copy of the launch environment as it is, without running a shell", async () => {
    const marker = join(directory, "ran");
    const unused = shell("unused", `touch '${marker}'`);
    const launch = { Path: "C:\\Windows" };
    const read = await readEnvironment(launch, { platform: "win32", shells: [unused] });
    expect(read).toEqual({ env: { Path: "C:\\Windows" }, failures: [] });
    expect(read.env).not.toBe(launch);
    expect(existsSync(marker)).toBe(false);
  });

  test("with EIDOLON_DESKTOP_LOGIN_SHELL=0, takes the launch environment as it is", async () => {
    const marker = join(directory, "ran");
    const unused = shell("unused", `touch '${marker}'`);
    const launch = { PATH: "/usr/bin", EIDOLON_DESKTOP_LOGIN_SHELL: "0" };
    await expect(
      readEnvironment(launch, { platform: "darwin", shells: [unused] }),
    ).resolves.toEqual({ env: launch, failures: [] });
    expect(existsSync(marker)).toBe(false);
  });

  // The stand-in shells are POSIX scripts.
  test.skipIf(process.platform === "win32")(
    "on macOS, merges the login shell's over the launch environment",
    async () => {
      const login = shell(
        "login",
        'export PATH="/opt/homebrew/bin:$PATH" EIDOLON_HOME=/rc PWD=/elsewhere',
      );
      const launch = { PATH: "/usr/bin:/bin", EIDOLON_HOME: "/tmp/smoke", HOME: homedir() };
      const { env, failures } = await readEnvironment(launch, {
        platform: "darwin",
        shells: [login],
      });
      expect(failures).toEqual([]);
      expect(env).toMatchObject({
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        EIDOLON_HOME: "/tmp/smoke",
      });
      expect(env).not.toHaveProperty("PWD");
      expect(env).not.toHaveProperty("DISABLE_AUTO_UPDATE");
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps the launch environment when every login shell fails, and logs why",
    async () => {
      const failing = shell("failing", "exit 3");
      const warn = vi.fn<(message: string) => void>();
      await expect(
        readEnvironment(
          { PATH: "/usr/bin:/bin" },
          { platform: "darwin", shells: [failing], log: { warn } },
        ),
      ).resolves.toEqual({
        env: { PATH: "/usr/bin:/bin" },
        failures: [{ shell: failing, reason: "exit 3" }],
      });
      expect(warn.mock.calls).toEqual([
        [
          `Eidolon: no login shell gave its environment, so the backend runs on the launch's: ${failing} (exit 3)`,
        ],
      ]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "logs the login shells that failed before one gave its environment",
    async () => {
      const failing = shell("failing", "exit 3");
      const working = shell("working", "export FROM=working");
      const warn = vi.fn<(message: string) => void>();
      const { env } = await readEnvironment(
        { PATH: "/usr/bin:/bin" },
        { platform: "darwin", shells: [failing, working], log: { warn } },
      );
      expect(env.FROM).toBe("working");
      expect(warn.mock.calls).toEqual([
        [`Eidolon: login shells that gave no environment before one did: ${failing} (exit 3)`],
      ]);
    },
  );
});

describe.skipIf(process.platform === "win32")("startupEnvironment", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A login shell that counts its runs and puts the folder written in `bin` first on PATH. */
  function counting(): { login: string; reads: () => number; bin: (folder: string) => void } {
    const counter = join(directory, "reads");
    const bin = join(directory, "bin");
    writeFileSync(bin, "/first/bin");
    return {
      login: shell("login", `echo x >> '${counter}'\nexport PATH="$(cat '${bin}'):$PATH"`),
      reads: () => (existsSync(counter) ? readFileSync(counter, "utf8").length / 2 : 0),
      bin: (folder) => writeFileSync(bin, folder),
    };
  }

  test("a cold start's first spawn takes the startup read, and every later spawn reads again", async () => {
    const { login, reads, bin } = counting();
    const environment = await startupEnvironment(
      { PATH: "/usr/bin:/bin" },
      { platform: "darwin", shells: [login] },
    );
    expect(environment.env.PATH).toBe("/first/bin:/usr/bin:/bin");
    expect(reads()).toBe(1);
    await expect(environment.forSpawn()).resolves.toBe(environment.env);
    expect(reads()).toBe(1);
    bin("/second/bin");
    await expect(environment.forSpawn()).resolves.toMatchObject({
      PATH: "/second/bin:/usr/bin:/bin",
    });
    await environment.forSpawn();
    expect(reads()).toBe(3);
  });

  test("a first spawn long after startup, once an attached server has gone, reads again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { login, reads, bin } = counting();
    const environment = await startupEnvironment(
      { PATH: "/usr/bin:/bin" },
      { platform: "darwin", shells: [login] },
    );
    vi.setSystemTime(Date.now() + 10_001);
    bin("/second/bin");
    await expect(environment.forSpawn()).resolves.toMatchObject({
      PATH: "/second/bin:/usr/bin:/bin",
    });
    expect(reads()).toBe(2);
  });
});
