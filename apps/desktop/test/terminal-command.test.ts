// The terminal command: where it stands and how Install and Remove change it, on temporary folders
// and fake runners. The real PowerShell runs in terminal-command-windows.test.ts.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { STRINGS, type Strings } from "../src/main/strings.ts";
import {
  type CommandHost,
  changeCommand,
  commandState,
  LINK,
  type RunResult,
  userPathScript,
} from "../src/main/terminal-command.ts";
import { powershellArgs } from "../src/main/update-signature.ts";
import type { Unavailable } from "../src/shared/bridge.ts";

const POSIX = process.platform !== "win32";

const scratch = mkdtempSync(join(tmpdir(), "eidolon-terminal-command-"));
/** Folders a test made read-only, which would keep rmSync from emptying them. */
const locked: string[] = [];
afterAll(() => {
  for (const dir of locked) chmodSync(dir, 0o755);
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function folder(name: string): string {
  return mkdtempSync(join(scratch, `${name}-`));
}

interface Run {
  readonly file: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
}

/** A host on `platform`, its runs answered by `answer`, its log lines and runs recorded. */
function hostOn(
  platform: NodeJS.Platform,
  over: Partial<CommandHost> = {},
  answer: (run: Run) => RunResult | Promise<RunResult> = () => {
    throw new Error("nothing should run");
  },
  strings: Strings = STRINGS.en,
) {
  const info: string[] = [];
  const warn: string[] = [];
  const runs: Run[] = [];
  const host: CommandHost = {
    platform,
    resourcesPath: "/nowhere",
    unavailable: null,
    strings: () => strings,
    log: { info: (line) => info.push(line), warn: (line) => warn.push(line) },
    run: async (file, args, options) => {
      const run = { file, args, ...options };
      runs.push(run);
      return answer(run);
    },
    ...over,
  };
  return { host, info, warn, runs };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

describe("a copy that can't offer the command", () => {
  const reasons: Unavailable[] = [
    "background",
    "unpackaged",
    "outside-applications",
    "not-installed",
  ];

  test.each(["darwin", "win32"] as const)(
    "on %s, answers why, refuses to change it, and runs nothing",
    async (platform) => {
      const link = join(folder("unavailable"), "eidolon");
      for (const reason of reasons) {
        const { host, warn, runs } = hostOn(platform, { unavailable: reason, link });
        const command = { state: "unavailable", reason };
        expect(await commandState(host)).toEqual(command);
        expect(await changeCommand(host, "install")).toEqual({ command, error: "failed" });
        expect(await changeCommand(host, "remove")).toEqual({ command, error: "failed" });
        expect(runs).toEqual([]);
        expect(warn).toEqual([
          `Eidolon: this copy can't install the eidolon command (${reason})`,
          `Eidolon: this copy can't remove the eidolon command (${reason})`,
        ]);
      }
      expect(existsSync(link)).toBe(false);
    },
  );

  test("on another platform, answers as an unpackaged copy and runs nothing", async () => {
    const { host, runs } = hostOn("linux");
    const command = { state: "unavailable", reason: "unpackaged" };
    expect(await commandState(host)).toEqual(command);
    expect(await changeCommand(host, "install")).toEqual({ command, error: "failed" });
    expect(runs).toEqual([]);
  });
});

// Real links in temporary folders: Windows makes a link only with Developer Mode on.
describe.skipIf(!POSIX)("on macOS", () => {
  /** An app's resources, its launcher, and the folder the link goes in. */
  function setup(name: string) {
    const resourcesPath = join(folder(name), "LAPLACE Eidolon.app", "Contents", "Resources");
    const launcher = join(resourcesPath, "bin", "eidolon");
    const bin = folder(`${name}-bin`);
    return { resourcesPath, launcher, bin, link: join(bin, "eidolon") };
  }

  test("reads the link: nothing or another copy's is absent, ours installed, the rest taken", async () => {
    const { resourcesPath, launcher, bin, link } = setup("state");
    const state = () => commandState(hostOn("darwin", { resourcesPath, link }).host);
    expect(await state()).toEqual({ state: "absent", path: link });
    symlinkSync(launcher, link);
    expect(await state()).toEqual({ state: "installed", path: link });
    unlinkSync(link);
    symlinkSync(relative(bin, launcher), link);
    expect(await state()).toEqual({ state: "installed", path: link });
    unlinkSync(link);
    symlinkSync("/Applications/Old Place/LAPLACE Eidolon.app/Contents/Resources/bin/eidolon", link);
    expect(await state()).toEqual({ state: "absent", path: link });
    unlinkSync(link);
    symlinkSync("/Applications/Old Place/Eidolon.app/Contents/Resources/bin/eidolon", link);
    expect(await state()).toEqual({ state: "absent", path: link });
    unlinkSync(link);
    // macOS's disks ignore case, so the moved copy's link may differ in it.
    symlinkSync("/Applications/old place/laplace eidolon.app/Contents/resources/BIN/eidolon", link);
    expect(await state()).toEqual({ state: "absent", path: link });
    unlinkSync(link);
    symlinkSync("/opt/homebrew/bin/eidolon", link);
    expect(await state()).toEqual({ state: "taken", path: link });
    unlinkSync(link);
    writeFileSync(link, "#!/bin/sh\n");
    expect(await state()).toEqual({ state: "taken", path: link });
    unlinkSync(link);
    mkdirSync(link);
    expect(await state()).toEqual({ state: "taken", path: link });
    // A file where the folder should be: nothing can be at the link.
    const file = join(bin, "file");
    writeFileSync(file, "");
    const under = join(file, "eidolon");
    expect(await commandState(hostOn("darwin", { resourcesPath, link: under }).host)).toEqual({
      state: "absent",
      path: under,
    });
  });

  test("Install links the launcher where the folder is writable, replacing another copy's link", async () => {
    const { resourcesPath, launcher, link } = setup("install");
    const { host, info, runs } = hostOn("darwin", { resourcesPath, link });
    expect(await changeCommand(host, "install")).toEqual({
      command: { state: "installed", path: link },
    });
    expect(readlinkSync(link)).toBe(launcher);
    unlinkSync(link);
    symlinkSync("/Applications/Old Place/LAPLACE Eidolon.app/Contents/Resources/bin/eidolon", link);
    expect(await changeCommand(host, "install")).toEqual({
      command: { state: "installed", path: link },
    });
    expect(readlinkSync(link)).toBe(launcher);
    // Already ours: nothing to do.
    expect(await changeCommand(host, "install")).toEqual({
      command: { state: "installed", path: link },
    });
    expect(info).toEqual([
      `Eidolon: installed the eidolon command at ${link}`,
      `Eidolon: installed the eidolon command at ${link}`,
    ]);
    expect(runs).toEqual([]);
  });

  test("Install and Remove leave something else at the link alone", async () => {
    const { resourcesPath, link } = setup("taken");
    const read = () =>
      lstatSync(link).isSymbolicLink() ? readlinkSync(link) : readFileSync(link, "utf8");
    for (const make of [
      () => writeFileSync(link, "#!/bin/sh\necho mine\n"),
      () => symlinkSync("/opt/homebrew/bin/eidolon", link),
    ]) {
      make();
      const before = { ino: lstatSync(link).ino, read: read() };
      const { host, warn, runs } = hostOn("darwin", { resourcesPath, link });
      for (const action of ["install", "remove"] as const) {
        expect(await changeCommand(host, action)).toEqual({
          command: { state: "taken", path: link },
          error: "failed",
        });
      }
      expect({ ino: lstatSync(link).ino, read: read() }).toEqual(before);
      expect(warn).toEqual([
        `Eidolon: didn't install the eidolon command: ${link} isn't Eidolon's`,
        `Eidolon: didn't remove the eidolon command: ${link} isn't Eidolon's`,
      ]);
      expect(runs).toEqual([]);
      unlinkSync(link);
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "a link it can't read is taken, and Install and Remove leave it alone",
    async () => {
      const { resourcesPath, launcher } = setup("unreadable");
      const sealed = folder("sealed");
      const link = join(sealed, "eidolon");
      symlinkSync(launcher, link);
      chmodSync(sealed, 0o000);
      locked.push(sealed);
      const { host, warn, runs } = hostOn("darwin", { resourcesPath, link });
      expect(await commandState(host)).toEqual({ state: "taken", path: link });
      for (const action of ["install", "remove"] as const) {
        expect(await changeCommand(host, action)).toEqual({
          command: { state: "taken", path: link },
          error: "failed",
        });
      }
      expect(warn).toHaveLength(2);
      expect(runs).toEqual([]);
      chmodSync(sealed, 0o755);
      expect(readlinkSync(link)).toBe(launcher);
    },
  );

  test("Remove takes away only Eidolon's links, ours or another copy's", async () => {
    const { resourcesPath, launcher, link } = setup("remove");
    const { host, info, runs } = hostOn("darwin", { resourcesPath, link });
    symlinkSync(launcher, link);
    expect(await changeCommand(host, "remove")).toEqual({
      command: { state: "absent", path: link },
    });
    expect(existsSync(link)).toBe(false);
    symlinkSync("/Applications/Old Place/Eidolon.app/Contents/Resources/bin/eidolon", link);
    expect(await changeCommand(host, "remove")).toEqual({
      command: { state: "absent", path: link },
    });
    expect(() => lstatSync(link)).toThrow();
    // Nothing there: nothing to do.
    expect(await changeCommand(host, "remove")).toEqual({
      command: { state: "absent", path: link },
    });
    expect(info).toEqual([
      `Eidolon: removed the eidolon command from ${link}`,
      `Eidolon: removed the eidolon command from ${link}`,
    ]);
    expect(runs).toEqual([]);
  });

  const INSTALL_ARGS = [
    "-e",
    "on run argv",
    "-e",
    'do shell script "/bin/mkdir -p /usr/local/bin && /bin/ln -sfh " & quoted form of item 1 of argv & " /usr/local/bin/eidolon" with prompt (item 2 of argv) with administrator privileges',
    "-e",
    "end run",
  ];
  const REMOVE_ARGS = [
    "-e",
    "on run argv",
    "-e",
    'do shell script "/bin/rm -f /usr/local/bin/eidolon" with prompt (item 1 of argv) with administrator privileges',
    "-e",
    "end run",
  ];

  test("Install asks for an administrator where the folder is missing, with the launcher and the prompt as arguments", async () => {
    expect(LINK).toBe("/usr/local/bin/eidolon");
    const { resourcesPath, launcher } = setup("admin");
    const link = join(folder("admin-missing"), "usr", "local", "bin", "eidolon");
    for (const language of ["en", "zh-Hans"] as const) {
      const strings = STRINGS[language];
      const { host, info, runs } = hostOn(
        "darwin",
        { resourcesPath, link },
        () => {
          // What the elevated mkdir and ln do, here.
          mkdirSync(dirname(link), { recursive: true });
          symlinkSync(launcher, link);
          return ok();
        },
        strings,
      );
      expect(await changeCommand(host, "install")).toEqual({
        command: { state: "installed", path: link },
      });
      expect(runs).toEqual([
        {
          file: "/usr/bin/osascript",
          args: [...INSTALL_ARGS, launcher, strings.text.installCommandPrompt],
        },
      ]);
      expect(info).toEqual([`Eidolon: installed the eidolon command at ${link}`]);
      rmSync(dirname(link), { recursive: true });
    }
  });

  test("a cancelled password prompt is cancelled, any other failure failed, and nothing changes", async () => {
    const { resourcesPath } = setup("cancel");
    const link = join(folder("cancel-missing"), "bin", "eidolon");
    const answers: [RunResult | Error, "cancelled" | "failed"][] = [
      [
        { code: 1, stdout: "", stderr: "0:210: execution error: User canceled. (-128)\n" },
        "cancelled",
      ],
      [
        {
          code: 1,
          stdout: "",
          stderr:
            "0:210: execution error: The administrator user name or password was incorrect. (-60007)\n",
        },
        "failed",
      ],
      [new Error("spawn /usr/bin/osascript ENOENT"), "failed"],
      // It says it ran, but there's no link.
      [ok(), "failed"],
    ];
    for (const [answer, error] of answers) {
      const { host, info, warn } = hostOn("darwin", { resourcesPath, link }, () => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      expect(await changeCommand(host, "install")).toEqual({
        command: { state: "absent", path: link },
        error,
      });
      expect(existsSync(link)).toBe(false);
      if (error === "cancelled") {
        expect(info).toEqual([
          "Eidolon: the password prompt to install the eidolon command was cancelled",
        ]);
        expect(warn).toEqual([]);
      } else {
        expect(info).toEqual([]);
        expect(warn).toHaveLength(1);
      }
    }
  });

  test.skipIf(process.getuid?.() === 0)(
    "Remove asks for an administrator where the folder is read-only, with the prompt as its argument",
    async () => {
      const { resourcesPath, launcher, bin, link } = setup("admin-remove");
      symlinkSync(launcher, link);
      chmodSync(bin, 0o555);
      locked.push(bin);
      const { host, info, runs } = hostOn("darwin", { resourcesPath, link }, () => {
        // What the elevated rm does, here.
        chmodSync(bin, 0o755);
        unlinkSync(link);
        chmodSync(bin, 0o555);
        return ok();
      });
      expect(await changeCommand(host, "remove")).toEqual({
        command: { state: "absent", path: link },
      });
      expect(runs).toEqual([
        { file: "/usr/bin/osascript", args: [...REMOVE_ARGS, STRINGS.en.text.removeCommandPrompt] },
      ]);
      expect(info).toEqual([`Eidolon: removed the eidolon command from ${link}`]);

      chmodSync(bin, 0o755);
      symlinkSync(launcher, link);
      chmodSync(bin, 0o555);
      const cancelled = hostOn("darwin", { resourcesPath, link }, () => ({
        code: 1,
        stdout: "",
        stderr: "0:73: execution error: User canceled. (-128)\n",
      }));
      expect(await changeCommand(cancelled.host, "remove")).toEqual({
        command: { state: "installed", path: link },
        error: "cancelled",
      });
      expect(readlinkSync(link)).toBe(launcher);
    },
  );
});

describe("on Windows", () => {
  const resourcesPath = "C:\\Users\\Zoë O'Neil\\AppData\\Local\\Programs\\eidolon\\resources";
  const path = `${resourcesPath}\\bin`;
  const script = (action: "query" | "add" | "remove", key?: string) =>
    powershellArgs(userPathScript(action, path, key));

  test("reads the user Path through the system's PowerShell, encoded, without PowerShell 7's module path", async () => {
    vi.stubEnv("PSModulePath", "C:\\Program Files\\PowerShell\\7\\Modules");
    vi.stubEnv("SystemRoot", "D:\\Windows");
    for (const [stdout, state] of [
      ["present", "installed"],
      ["absent\r\n", "absent"],
    ] as const) {
      const { host, runs } = hostOn("win32", { resourcesPath }, () => ok(stdout));
      expect(await commandState(host)).toEqual({ state, path });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        file: "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: script("query"),
        timeout: 60_000,
      });
      // Compared whole: on Windows the PATH variable's name is usually Path.
      const kept = Object.entries(process.env).filter(([name]) => !/^psmodulepath$/i.test(name));
      expect(runs[0]?.env).toEqual(Object.fromEntries(kept));
    }
  });

  test("a read that fails is absent, and says why in main.log", async () => {
    for (const answer of [
      { code: 1, stdout: "", stderr: "Requested registry access is not allowed." },
      ok("#< CLIXML"),
    ]) {
      const { host, warn } = hostOn("win32", { resourcesPath }, () => answer);
      expect(await commandState(host)).toEqual({ state: "absent", path });
      expect(warn).toHaveLength(1);
      expect(warn[0]).toMatch(/^Eidolon: couldn't read your PATH for the eidolon command: /);
    }
  });

  test("Install adds the folder and Remove takes it away, each logged", async () => {
    const { host, info, runs } = hostOn("win32", { resourcesPath }, ({ args }) =>
      ok(args.at(-1) === script("add").at(-1) ? "present" : "absent"),
    );
    expect(await changeCommand(host, "install")).toEqual({
      command: { state: "installed", path },
    });
    expect(await changeCommand(host, "remove")).toEqual({ command: { state: "absent", path } });
    expect(runs.map(({ args }) => args)).toEqual([script("add"), script("remove")]);
    expect(info).toEqual([
      `Eidolon: installed the eidolon command: ${path} is on your PATH`,
      `Eidolon: removed the eidolon command: ${path} is off your PATH`,
    ]);
  });

  test("a change that fails reads the Path again and says why", async () => {
    const { host, warn, runs } = hostOn("win32", { resourcesPath }, ({ args }) =>
      args.at(-1) === script("add").at(-1)
        ? { code: 1, stdout: "", stderr: "Path is Binary, not text" }
        : ok("absent"),
    );
    expect(await changeCommand(host, "install")).toEqual({
      command: { state: "absent", path },
      error: "failed",
    });
    expect(runs.map(({ args }) => args)).toEqual([script("add"), script("query")]);
    expect(warn).toEqual([
      "Eidolon: couldn't install the eidolon command: Error: PowerShell exited with 1: Path is Binary, not text",
    ]);
  });

  test("a test's key reaches the script, which broadcasts the change only for the real one", async () => {
    const key = "Software\\Eidolon Test\\scratch";
    const { host, runs } = hostOn("win32", { resourcesPath, userKey: key }, () => ok("present"));
    await changeCommand(host, "install");
    expect(runs[0]?.args).toEqual(script("add", key));
    const broadcast =
      "[Environment]::SetEnvironmentVariable('EIDOLON_PATH_CHANGED', $null, 'User')";
    expect(userPathScript("add", path)).toContain(broadcast);
    expect(userPathScript("remove", path)).toContain(broadcast);
    expect(userPathScript("add", path, key)).not.toContain(broadcast);
    expect(userPathScript("add", path, key)).toContain("$name = 'Software\\Eidolon Test\\scratch'");
  });

  test("the script takes its values as literals, and never sets Path but through the key", () => {
    for (const action of ["query", "add", "remove"] as const) {
      const text = userPathScript(action, path);
      expect(text).toContain(`$action = '${action}'`);
      expect(text).toContain("$name = 'Environment'");
      expect(text).toContain(
        "$folder = 'C:\\Users\\Zoë O''Neil\\AppData\\Local\\Programs\\eidolon\\resources\\bin'",
      );
      expect(text).toContain("GetValue('Path', '', 'DoNotExpandEnvironmentNames')");
      expect(text).not.toMatch(/SetEnvironmentVariable\('Path'|setx/i);
    }
    // PowerShell's other single quotes, doubled as the plain one is.
    expect(userPathScript("query", "C:\\Users\\O’Neil ‘‚‛\\bin")).toContain(
      "$folder = 'C:\\Users\\O’’Neil ‘‘‚‚‛‛\\bin'",
    );
  });
});
