// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/tests/login-shell-environment.spec.ts@2e39e70496
//
// deepseek's merge, with Eidolon's own rules: the launch environment's EIDOLON_* names win, Windows
// reads and writes names in any case and merges the registry's variables, and a respawn stays on
// main's data home.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { backendEnv } from "../src/main/controller.ts";
import {
  launchFlag,
  loginShellOff,
  mergeRegistryEnvironment,
  mergeShellEnvironment,
  readEnvironment,
  startupEnvironment,
} from "../src/main/environment.ts";
import {
  ENVIRONMENT_KEYS,
  type RegistryValue,
  registryScript,
} from "../src/main/registry-environment.ts";

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

/**
 * A stand-in powershell.exe for the launch's PATH: it checks it was given an encoded script, keeps
 * the script, then runs `body`.
 */
function powershell(body: string): { readonly path: string; readonly script: () => string } {
  const bin = join(directory, "bin");
  const kept = join(directory, "script");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "powershell.exe"),
    [
      "#!/bin/sh",
      '[ "$1 $2 $3 $4 $5" = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand" ] || exit 64',
      `printf %s "$6" > '${kept}'`,
      body,
    ].join("\n"),
  );
  chmodSync(join(bin, "powershell.exe"), 0o755);
  return {
    path: `${bin}:/usr/bin:/bin`,
    script: () => Buffer.from(readFileSync(kept, "utf8"), "base64").toString("utf16le"),
  };
}

/** One value as the registry script prints it. */
interface Printed {
  readonly Key: number;
  readonly Name: string;
  readonly Kind: string;
  readonly Value: string;
}

/** A stand-in body that prints the registry script's output for `records`, which a later call replaces. */
function prints(records: readonly Printed[]): string {
  const file = join(directory, "registry.json");
  writeFileSync(file, JSON.stringify(records));
  return `cat '${file}'`;
}

const sz = (name: string, value: string): RegistryValue => ({ name, kind: "String", value });
const expandSz = (name: string, value: string): RegistryValue => ({
  name,
  kind: "ExpandString",
  value,
});

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

describe("mergeRegistryEnvironment", () => {
  test("applies the system's values, then the user's, then the session's, and keeps what none has", () => {
    const launch = {
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\owner",
      USERNAME: "owner",
      temp: "C:\\Users\\owner\\AppData\\Local\\Temp",
      FROM_LAUNCH: "kept",
    };
    const merged = mergeRegistryEnvironment(launch, [
      [
        sz("USERNAME", "SYSTEM"),
        expandSz("TEMP", "%SystemRoot%\\TEMP"),
        sz("BOTH", "system"),
        sz("SYSTEM_ONLY", "system"),
      ],
      [expandSz("TEMP", "%USERPROFILE%\\AppData\\Local\\Temp\\2"), sz("BOTH", "user")],
      [sz("USERNAME", "owner")],
    ]);
    expect(merged).toEqual({
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\Users\\owner",
      USERNAME: "owner",
      temp: "C:\\Users\\owner\\AppData\\Local\\Temp\\2",
      FROM_LAUNCH: "kept",
      BOTH: "user",
      SYSTEM_ONLY: "system",
    });
    expect(launch.temp).toBe("C:\\Users\\owner\\AppData\\Local\\Temp");
  });

  test("makes Path the system's then the user's, under the launch's one key", () => {
    const launch = { PATH: "C:\\Stale;C:\\Users\\owner\\Stale", SystemRoot: "C:\\Windows" };
    const merged = mergeRegistryEnvironment(launch, [
      [expandSz("Path", "%SystemRoot%\\system32;C:\\Program Files\\Git\\cmd")],
      [sz("path", "C:\\Users\\owner\\bin")],
      [],
    ]);
    expect(merged).toEqual({
      PATH: "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Users\\owner\\bin",
      SystemRoot: "C:\\Windows",
    });
    expect(spellings(merged, "PATH")).toEqual(["PATH"]);
    expect(mergeRegistryEnvironment(launch, [[], [sz("Path", "C:\\Users\\owner\\bin")]])).toEqual({
      PATH: "C:\\Users\\owner\\bin",
      SystemRoot: "C:\\Windows",
    });
  });

  test("expands REG_EXPAND_SZ against the variables so far, after the key's REG_SZ, and takes no other kind", () => {
    const merged = mergeRegistryEnvironment({ SystemRoot: "C:\\Windows" }, [
      [
        expandSz(
          "Path",
          "%JAVA_HOME%\\bin;%systemroot%\\system32;%NOPE%\\x;C:\\50%\\y;%JAVA_HOME%\\z",
        ),
        sz("JAVA_HOME", "C:\\Java"),
        sz("LITERAL", "%SystemRoot%\\literal"),
        { name: "NUMBER", kind: "DWord", value: "1" },
        { name: "LIST", kind: "MultiString", value: "a b" },
      ],
      [expandSz("FROM_USER", "%java_home%;%LITERAL%;100%")],
    ]);
    expect(merged).toEqual({
      SystemRoot: "C:\\Windows",
      // JAVA_HOME, a REG_SZ, is set before the Path listed ahead of it. An unknown name stays, and
      // its closing % opens the next one.
      Path: "C:\\Java\\bin;C:\\Windows\\system32;%NOPE%\\x;C:\\50%\\y;C:\\Java\\z",
      JAVA_HOME: "C:\\Java",
      LITERAL: "%SystemRoot%\\literal",
      FROM_USER: "C:\\Java;%SystemRoot%\\literal;100%",
    });
  });

  test("leaves what the shell's merge leaves: the probe's own, ELECTRON_* and the launch's EIDOLON_*", () => {
    const merged = mergeRegistryEnvironment({ Eidolon_Home: "C:\\smoke", EIDOLON_PERSONA: "" }, [
      [
        sz("EIDOLON_HOME", "C:\\registry"),
        sz("EIDOLON_PERSONA", "from-registry"),
        expandSz("EIDOLON_SHARED_SKILLS", "%EIDOLON_HOME%\\skills"),
        sz("electron_run_as_node", "1"),
        sz("PWD", "C:\\"),
        sz("_", "C:\\Windows\\system32\\cmd.exe"),
      ],
    ]);
    expect(merged).toEqual({
      Eidolon_Home: "C:\\smoke",
      EIDOLON_PERSONA: "from-registry",
      EIDOLON_SHARED_SKILLS: "C:\\smoke\\skills",
    });
  });
});

// The stand-in shell is a POSIX script.
test.skipIf(process.platform === "win32")(
  "a respawn stays on main's data home after the rc's EIDOLON_HOME moves",
  async () => {
    const exported = join(directory, "home");
    writeFileSync(exported, "/a");
    const login = shell("login", `export EIDOLON_HOME="$(cat '${exported}')"`);
    // A Finder launch, with no EIDOLON_HOME of its own: main's home comes from the rc's.
    const startup = await startupEnvironment(
      { PATH: "/usr/bin:/bin" },
      { platform: "darwin", shells: [login] },
    );
    const resolved = startup.env.EIDOLON_HOME as string;
    expect(resolved).toBe("/a");
    await startup.forSpawn();
    writeFileSync(exported, "/b");
    const respawn = await startup.forSpawn();
    expect(respawn.EIDOLON_HOME).toBe("/b");
    expect(
      backendEnv(respawn, { home: resolved, appRoot: null, platform: "darwin" }).EIDOLON_HOME,
    ).toBe("/a");
  },
);

test("a launch flag reads as envFlag does, on and off both ways, blank as unset", () => {
  const flag = (value: string | undefined, fallback: boolean) =>
    launchFlag(value === undefined ? {} : { FLAG: value }, "FLAG", fallback, "darwin");
  for (const fallback of [false, true]) {
    for (const on of ["1", "true", " Yes ", "ON"]) expect(flag(on, fallback), on).toBe(true);
    for (const off of ["0", "false", " no ", "OFF"]) expect(flag(off, fallback), off).toBe(false);
    for (const unset of [undefined, "", "  "]) expect(flag(unset, fallback)).toBe(fallback);
  }
  // Anything else leaves a flag as it defaults.
  expect(flag("maybe", false)).toBe(false);
  expect(flag("maybe", true)).toBe(true);
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
  // The stand-ins are POSIX scripts.
  test.skipIf(process.platform === "win32")(
    "on Windows, merges the registry's variables over the launch's, without running a login shell",
    async () => {
      const marker = join(directory, "ran");
      const unused = shell("unused", `touch '${marker}'`);
      const stand = powershell(
        prints([
          { Key: 0, Name: "Path", Kind: "ExpandString", Value: "%SystemRoot%\\system32" },
          { Key: 0, Name: "USERNAME", Kind: "String", Value: "SYSTEM" },
          { Key: 1, Name: "Path", Kind: "String", Value: "C:\\Users\\owner\\bin" },
          { Key: 2, Name: "USERNAME", Kind: "String", Value: "owner" },
        ]),
      );
      const launch = { PATH: stand.path, SystemRoot: "C:\\Windows", USERNAME: "owner" };
      const read = await readEnvironment(launch, { platform: "win32", shells: [unused] });
      expect(read).toEqual({
        env: {
          PATH: "C:\\Windows\\system32;C:\\Users\\owner\\bin",
          SystemRoot: "C:\\Windows",
          USERNAME: "owner",
        },
        failures: [],
      });
      expect(launch.PATH).toBe(stand.path);
      expect(stand.script()).toBe(registryScript(ENVIRONMENT_KEYS));
      expect(existsSync(marker)).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "on Windows, keeps the launch environment when the read fails, and logs why",
    async () => {
      const stand = powershell("printf 'Access is denied.\\r\\nAt line:1 char:1\\n' >&2; exit 1");
      const warn = vi.fn<(message: string) => void>();
      for (const launch of [{ PATH: stand.path }, { PATH: "/usr/bin:/bin" }]) {
        const read = await readEnvironment(launch, { platform: "win32", log: { warn } });
        expect(read).toEqual({ env: launch, failures: [] });
        expect(read.env).not.toBe(launch);
      }
      const why =
        "Eidolon: couldn't read the registry's variables, so the backend runs on the launch's";
      expect(warn.mock.calls).toEqual([
        [`${why}: exit 1: Access is denied.`],
        [`${why}: spawn powershell.exe ENOENT`],
      ]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "on Windows, with EIDOLON_DESKTOP_LOGIN_SHELL off in any case, takes the launch environment without reading the registry",
    async () => {
      const marker = join(directory, "ran");
      const stand = powershell(`touch '${marker}'`);
      const launch = { PATH: stand.path, eidolon_desktop_login_shell: "off" };
      await expect(readEnvironment(launch, { platform: "win32" })).resolves.toEqual({
        env: launch,
        failures: [],
      });
      expect(existsSync(marker)).toBe(false);
    },
  );

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
    const startup = await startupEnvironment(
      { PATH: "/usr/bin:/bin" },
      { platform: "darwin", shells: [login] },
    );
    expect(startup.env.PATH).toBe("/first/bin:/usr/bin:/bin");
    expect(reads()).toBe(1);
    await expect(startup.forSpawn()).resolves.toBe(startup.env);
    expect(reads()).toBe(1);
    bin("/second/bin");
    await expect(startup.forSpawn()).resolves.toMatchObject({
      PATH: "/second/bin:/usr/bin:/bin",
    });
    await startup.forSpawn();
    expect(reads()).toBe(3);
  });

  test("a first spawn long after startup, once an attached server has gone, reads again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { login, reads, bin } = counting();
    const startup = await startupEnvironment(
      { PATH: "/usr/bin:/bin" },
      { platform: "darwin", shells: [login] },
    );
    vi.setSystemTime(Date.now() + 10_001);
    bin("/second/bin");
    await expect(startup.forSpawn()).resolves.toMatchObject({
      PATH: "/second/bin:/usr/bin:/bin",
    });
    expect(reads()).toBe(2);
  });

  test("on Windows, a cold start's first spawn takes the startup read, and a later one reads the registry again", async () => {
    const runs = join(directory, "runs");
    const path = (folder: string) =>
      prints([{ Key: 0, Name: "Path", Kind: "String", Value: folder }]);
    const stand = powershell(`echo x >> '${runs}'\n${path("C:\\First")}`);
    const startup = await startupEnvironment({ PATH: stand.path }, { platform: "win32" });
    expect(startup.env.PATH).toBe("C:\\First");
    await expect(startup.forSpawn()).resolves.toBe(startup.env);
    path("C:\\Second");
    await expect(startup.forSpawn()).resolves.toMatchObject({ PATH: "C:\\Second" });
    expect(readFileSync(runs, "utf8")).toBe("x\nx\n");
  });
});
