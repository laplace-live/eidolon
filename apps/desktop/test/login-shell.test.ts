// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/tests/login-shell-environment.spec.ts@2e39e70496
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";
import {
  loginShellCandidates,
  parseLoginShellOutput,
  readLoginShell,
} from "../src/main/login-shell.ts";

const account = vi.hoisted(() => ({ userInfo: vi.fn() }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  userInfo: account.userInfo,
}));

const MODULE = join(import.meta.dirname, "../src/main/login-shell.ts");
const DELIMITER = "_EIDOLON_SHELL_ENV_DELIMITER_";
const timeoutMs = 5_000;
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "eidolon-login-shell-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Whether `pid` has exited; Linux keeps a killed process as a zombie until its new parent reaps it. */
function exited(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      return /^State:\s+[ZXx]\b/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
    }
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return true;
    throw error;
  }
}

/** A stand-in login shell: `body` plays the rc files, then the dump runs under /bin/sh. */
function shell(name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n[ "$1" = -ilc ] || exit 64\n${body}\nexec /bin/sh -c "$2"\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("loginShellCandidates", () => {
  test.each([
    ["/opt/homebrew/bin/fish", ["/opt/homebrew/bin/fish", "/bin/zsh", "/bin/bash", "/bin/sh"]],
    ["/bin/bash", ["/bin/bash", "/bin/zsh", "/bin/sh"]],
    ["", ["/bin/zsh", "/bin/bash", "/bin/sh"]],
    [null, ["/bin/zsh", "/bin/bash", "/bin/sh"]],
  ])("tries the account's shell %j before the distinct system shells", (shell, candidates) => {
    account.userInfo.mockReturnValueOnce({ shell });
    expect(loginShellCandidates()).toEqual(candidates);
  });

  test("tries only the system shells when the account record is unreadable", () => {
    account.userInfo.mockImplementationOnce(() => {
      throw new Error("ENOENT: no such user");
    });
    expect(loginShellCandidates()).toEqual(["/bin/zsh", "/bin/bash", "/bin/sh"]);
  });
});

describe("parseLoginShellOutput", () => {
  test("reads only the variables between the delimiters", () => {
    const output = `motd\0${DELIMITER}\0A=1\0MULTI=x\ny=z\0=ignored\0NOEQUALS\0\0${DELIMITER}\0trailing`;
    expect(parseLoginShellOutput(output)).toEqual({ A: "1", MULTI: "x\ny=z" });
  });

  test("refuses output without both delimiters", () => {
    expect(parseLoginShellOutput("A=1\0")).toBeUndefined();
    expect(parseLoginShellOutput(`\0${DELIMITER}\0A=1\0`)).toBeUndefined();
  });
});

describe("readLoginShell", () => {
  test("records a candidate whose path can't be passed to spawn", async () => {
    await expect(readLoginShell({}, { shells: ["/bin/sh\0"], timeoutMs })).resolves.toEqual({
      variables: null,
      failures: [{ shell: "/bin/sh\0", reason: expect.stringContaining("null bytes") as string }],
    });
  });

  test("skips every candidate when already aborted", async () => {
    await expect(
      readLoginShell({}, { shells: ["/a", "/b"], timeoutMs, signal: AbortSignal.abort() }),
    ).resolves.toEqual({ variables: null, failures: [{ shell: "/a", reason: "aborted" }] });
  });
});

// The stand-in shells are POSIX scripts.
describe.skipIf(process.platform === "win32")("readLoginShell on POSIX", () => {
  test("returns what the rc files export, past their other output, read in the home folder", async () => {
    const login = shell(
      "login",
      [
        'echo "rc banner"',
        '[ "$DISABLE_AUTO_UPDATE" = true ] && [ "$ZSH_TMUX_AUTOSTART" = false ] || exit 65',
        'read -r answer || answer=eof; export ANSWER="$answer"',
        'export PATH="/login/bin:$PATH" MULTI=\'a\nb\' STARTED_IN="$PWD"',
      ].join("\n"),
    );
    const result = await readLoginShell(
      { PATH: "/usr/bin:/bin", KEPT: "1" },
      { shells: [login], timeoutMs },
    );
    expect(result.failures).toEqual([]);
    expect(result.variables).toMatchObject({
      PATH: "/login/bin:/usr/bin:/bin",
      KEPT: "1",
      MULTI: "a\nb",
      ANSWER: "eof",
      STARTED_IN: homedir(),
    });
  });

  test("records each failing candidate and uses the next one", async () => {
    const candidates = [
      join(directory, "missing"),
      shell("exits", "exit 3"),
      shell("signalled", "kill -TERM $$"),
      shell("silent", "exit 0"),
      shell("working", "export FROM=working"),
    ];
    const result = await readLoginShell(
      { PATH: "/usr/bin:/bin" },
      { shells: candidates, timeoutMs },
    );
    expect(result.variables?.FROM).toBe("working");
    expect(result.failures).toEqual([
      { shell: candidates[0], reason: expect.stringContaining("ENOENT") as string },
      { shell: candidates[1], reason: "exit 3" },
      { shell: candidates[2], reason: "SIGTERM" },
      { shell: candidates[3], reason: "unparsed" },
    ]);
  });

  test("ends at the closing delimiter while an rc-started child keeps stdout open", async () => {
    const pidFile = join(directory, "child.pid");
    const detaching = shell(
      "detaching",
      `sleep 30 & echo $! > '${pidFile}'\nexport FROM=detaching`,
    );
    const result = await readLoginShell(
      { PATH: "/usr/bin:/bin" },
      { shells: [detaching], timeoutMs },
    );
    const child = Number(readFileSync(pidFile, "utf8"));
    onTestFinished(() => {
      process.kill(child, "SIGKILL");
    });
    expect(result.failures).toEqual([]);
    expect(result.variables?.FROM).toBe("detaching");
    expect(exited(child)).toBe(false);
  });

  test("records each shell that can't spawn for want of file descriptors, without throwing", async () => {
    // A Node of its own, out of descriptors: there spawn returns a child without stdout.
    const probe = join(directory, "probe.mjs");
    writeFileSync(
      probe,
      [
        'import { closeSync, openSync } from "node:fs";',
        "const { readLoginShell } = await import(process.env.MODULE);",
        "const shells = JSON.parse(process.env.SHELLS);",
        "const held = [];",
        'try { for (;;) held.push(openSync("/dev/null", "r")); } catch {}',
        "const read = await readLoginShell({}, { shells, timeoutMs: 5000 });",
        "for (const fd of held) closeSync(fd);",
        "process.stdout.write(JSON.stringify(read));",
      ].join("\n"),
    );
    const candidates = [shell("first", "export FROM=first"), shell("second", "export FROM=second")];
    // The paths reach the shell as variables: CodeQL reads its arguments as part of its command.
    const { stdout } = await promisify(execFile)(
      "/bin/sh",
      ["-c", 'ulimit -n 256 && exec "$NODE" "$PROBE"'],
      {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: directory,
          NODE: process.execPath,
          PROBE: probe,
          MODULE: pathToFileURL(MODULE).href,
          SHELLS: JSON.stringify(candidates),
        },
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      variables: null,
      failures: candidates.map((candidate) => ({
        shell: candidate,
        reason: `spawn ${candidate} EMFILE`,
      })),
    });
  });

  test("kills a shell past its deadline with its background children, and gives nothing", async () => {
    const pidFile = join(directory, "child.pid");
    const hanging = shell("hanging", `sleep 30 & echo $! > '${pidFile}'; wait`);
    const result = await readLoginShell(
      { PATH: "/usr/bin:/bin" },
      { shells: [hanging], timeoutMs: 1_000 },
    );
    expect(result).toEqual({ variables: null, failures: [{ shell: hanging, reason: "timeout" }] });
    const child = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(exited(child)).toBe(true));
  });

  test("kills the running shell's group on abort and skips the rest", async () => {
    const pidFile = join(directory, "child.pid");
    const hanging = shell("hanging", `sleep 30 & echo $! > '${pidFile}'; wait`);
    const controller = new AbortController();
    const read = readLoginShell(
      { PATH: "/usr/bin:/bin" },
      {
        shells: [hanging, shell("unused", "export FROM=unused")],
        timeoutMs,
        signal: controller.signal,
      },
    );
    const child = await vi.waitFor(() => {
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      return pid;
    });
    controller.abort();
    await expect(read).resolves.toEqual({
      variables: null,
      failures: [{ shell: hanging, reason: "aborted" }],
    });
    await vi.waitFor(() => expect(exited(child)).toBe(true));
  });
});
