// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/tests/login-shell-environment.spec.ts@2e39e70496
//
// deepseek's merge, with Eidolon's own rules: the launch environment's EIDOLON_* names win, Windows
// reads and writes names in any case, and the backend runs as the app's Node on the payload.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backendEnvironment,
  dataHome,
  loginShellOff,
  mergeShellEnvironment,
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
  test("runs the app's binary as Node on the payload, with no .env", () => {
    const launch = { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "0" };
    expect(withBackendVariables(launch, "/Applications/Eidolon.app/x", "darwin")).toEqual({
      PATH: "/usr/bin",
      EIDOLON_APP_ROOT: "/Applications/Eidolon.app/x",
      EIDOLON_NO_DOTENV: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(launch.ELECTRON_RUN_AS_NODE).toBe("0");
  });

  test("leaves EIDOLON_APP_ROOT out for the dev backend, which finds its files in the checkout", () => {
    expect(withBackendVariables({ EIDOLON_APP_ROOT: "/stale" }, null, "darwin")).toEqual({
      EIDOLON_NO_DOTENV: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  test("on Windows, starting from {Path: C:\\Windows}, writes each name once in any case", () => {
    const env = withBackendVariables(
      {
        Path: "C:\\Windows",
        eidolon_app_root: "C:\\old",
        Electron_Run_As_Node: "0",
        EIDOLON_NO_DOTENV: "0",
        eidolon_no_dotenv: "0",
      },
      "C:\\Users\\owner\\AppData\\Local\\Programs\\eidolon\\resources\\eidolon",
      "win32",
    );
    expect(env).toEqual({
      Path: "C:\\Windows",
      eidolon_app_root: "C:\\Users\\owner\\AppData\\Local\\Programs\\eidolon\\resources\\eidolon",
      Electron_Run_As_Node: "1",
      EIDOLON_NO_DOTENV: "1",
    });
    expect(
      withBackendVariables({ Path: "C:\\Windows", eidolon_app_root: "x" }, null, "win32"),
    ).toEqual({ Path: "C:\\Windows", EIDOLON_NO_DOTENV: "1", ELECTRON_RUN_AS_NODE: "1" });
  });
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

describe("backendEnvironment", () => {
  test("on Windows, takes the launch environment as it is, without running a shell", async () => {
    const marker = join(directory, "ran");
    const unused = shell("unused", `touch '${marker}'`);
    await expect(
      backendEnvironment(
        { Path: "C:\\Windows" },
        { appRoot: "C:\\eidolon", platform: "win32", shells: [unused] },
      ),
    ).resolves.toEqual({
      env: {
        Path: "C:\\Windows",
        EIDOLON_APP_ROOT: "C:\\eidolon",
        EIDOLON_NO_DOTENV: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
      failures: [],
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("with EIDOLON_DESKTOP_LOGIN_SHELL=0, takes the launch environment as it is", async () => {
    const marker = join(directory, "ran");
    const unused = shell("unused", `touch '${marker}'`);
    const launch = { PATH: "/usr/bin", EIDOLON_DESKTOP_LOGIN_SHELL: "0" };
    const { env, failures } = await backendEnvironment(launch, {
      appRoot: null,
      platform: "darwin",
      shells: [unused],
    });
    expect(env).toEqual({ ...launch, EIDOLON_NO_DOTENV: "1", ELECTRON_RUN_AS_NODE: "1" });
    expect(failures).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  // The stand-in shells are POSIX scripts.
  test.skipIf(process.platform === "win32")(
    "on macOS, merges the login shell's over the launch environment, read at each call",
    async () => {
      const counter = join(directory, "reads");
      const login = shell(
        "login",
        `echo x >> '${counter}'\nexport PATH="/opt/homebrew/bin:$PATH" EIDOLON_HOME=/rc PWD=/elsewhere`,
      );
      const launch = { PATH: "/usr/bin:/bin", EIDOLON_HOME: "/tmp/smoke", HOME: homedir() };
      const options = { appRoot: "/payload", platform: "darwin", shells: [login] } as const;
      const first = await backendEnvironment(launch, options);
      expect(first.failures).toEqual([]);
      expect(first.env).toMatchObject({
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        EIDOLON_HOME: "/tmp/smoke",
        EIDOLON_APP_ROOT: "/payload",
        EIDOLON_NO_DOTENV: "1",
        ELECTRON_RUN_AS_NODE: "1",
      });
      expect(first.env).not.toHaveProperty("PWD");
      expect(first.env).not.toHaveProperty("DISABLE_AUTO_UPDATE");
      await backendEnvironment(launch, options);
      expect(readFileSync(counter, "utf8")).toBe("x\nx\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps the launch environment when every login shell fails, and says why",
    async () => {
      const failing = shell("failing", "exit 3");
      const launch = { PATH: "/usr/bin:/bin" };
      await expect(
        backendEnvironment(launch, { appRoot: "/payload", platform: "darwin", shells: [failing] }),
      ).resolves.toEqual({
        env: {
          PATH: "/usr/bin:/bin",
          EIDOLON_APP_ROOT: "/payload",
          EIDOLON_NO_DOTENV: "1",
          ELECTRON_RUN_AS_NODE: "1",
        },
        failures: [{ shell: failing, reason: "exit 3" }],
      });
    },
  );
});

describe("dataHome", () => {
  test("is EIDOLON_HOME, ~ expanded, else ~/.laplace/eidolon, blank counting as unset", () => {
    expect(dataHome({ EIDOLON_HOME: "/tmp/home" }, "darwin")).toBe("/tmp/home");
    expect(dataHome({ EIDOLON_HOME: "~/eidolon" }, "darwin")).toBe(join(homedir(), "eidolon"));
    expect(dataHome({ EIDOLON_HOME: "~" }, "darwin")).toBe(homedir());
    expect(dataHome({ EIDOLON_HOME: "relative" }, "darwin")).toBe(resolve("relative"));
    for (const env of [{}, { EIDOLON_HOME: "" }]) {
      expect(dataHome(env, "darwin")).toBe(join(homedir(), ".laplace", "eidolon"));
    }
  });

  test("on Windows, finds the name in any case and expands ~\\", () => {
    expect(dataHome({ Eidolon_Home: "~\\eidolon" }, "win32")).toBe(join(homedir(), "eidolon"));
  });
});
