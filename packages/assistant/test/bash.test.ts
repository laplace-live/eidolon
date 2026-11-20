// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/test/tools.test.ts@ac78a60
//
// pi's bash cases that hold without its temp files, structured content or streaming updates, on
// real processes and on fake operations; then this tool's own: the cut environment, no input or
// terminal, cleaned output, the output cap, its arguments, real process-group kills, and `wait`.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskToolResult } from "@eidolon/engine";
import { afterAll, describe, expect, test } from "vitest";
import {
  BASH_OUTPUT,
  type BashOperations,
  bashCommand,
  bashTimeoutSeconds,
  createBashTool,
  createLocalBashOperations,
  MAX_COMMAND_BYTES,
} from "../src/tools/bash.ts";
import { type BashDetails, BashJobs, type BashJobsOptions } from "../src/tools/jobs.ts";
import { bashOffered } from "../src/tools/shell.ts";
import type { AssistantTool } from "../src/types.ts";
import { folderGuard, removeTempFolders, tempFolder } from "./tool-folder.ts";

const posix = !bashOffered();
const spawned: number[] = [];

afterAll(async () => {
  // A failed kill test would leave its sleep 300 running: these are this file's own.
  for (const pid of spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
  await removeTempFolders();
});

interface Setup {
  readonly folder: string;
  readonly dir: string;
  readonly jobs: BashJobs;
  readonly tool: AssistantTool;
}

async function setup(options: BashJobsOptions = {}): Promise<Setup> {
  const folder = await tempFolder();
  const records = await tempFolder();
  const jobs = await BashJobs.open(records, options);
  return {
    folder,
    dir: join(records, "bash"),
    jobs,
    tool: createBashTool(folderGuard(folder), jobs),
  };
}

function bash(
  tool: AssistantTool,
  args: Record<string, unknown>,
  more: { signal?: AbortSignal; steered?: () => boolean } = {},
): Promise<TaskToolResult> {
  return tool.execute(args, {
    signal: more.signal ?? new AbortController().signal,
    onUpdate() {},
    ...(more.steered === undefined ? {} : { steered: more.steered }),
  });
}

/** Operations that run `script` in place of any command. */
function fake(script: BashOperations["exec"]): BashOperations {
  return { exec: script };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function deadWithin(pid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await delay(20)) {
    if (!alive(pid)) return true;
  }
  return !alive(pid);
}

/** The pids a command printed into its log, once there are `count`. */
async function pidsIn(log: string, count: number): Promise<number[]> {
  for (const end = Date.now() + 5000; Date.now() < end; await delay(20)) {
    let text = "";
    try {
      text = readFileSync(log, "utf8");
    } catch {}
    const pids = text.split("\n").filter(Boolean).map(Number);
    if (pids.length >= count) {
      spawned.push(...pids);
      return pids;
    }
  }
  throw new Error(`${log} never held ${count} pids`);
}

describe.skipIf(posix)("bash, as pi has it", () => {
  test("executes a simple command", async () => {
    const { tool } = await setup();
    const result = await bash(tool, { command: "echo 'test output'" });
    expect(result.content).toBe("test output\n");
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ id: 1, background: false, end: "exit", exitCode: 0 });
  });

  test("reports a non-zero exit as an error that keeps the output, and nothing as (no output)", async () => {
    const { tool } = await setup();
    const failed = await bash(tool, { command: "echo out; exit 3" });
    expect(failed).toMatchObject({ content: "out\n\n\nCommand exited with code 3", isError: true });
    const empty = await bash(tool, { command: "true" });
    expect(empty.content).toBe("(no output)");
    const silentFailure = await bash(tool, { command: "exit 4" });
    expect(silentFailure.content).toBe("(no output)\n\nCommand exited with code 4");
  });

  test("cuts seq 3000 from the tail, says where the rest is, and logs all of it", async () => {
    const { tool, dir } = await setup();
    const result = await bash(tool, { command: "seq 3000" });
    expect(result.content).not.toContain("\n1\n2\n");
    expect(result.content).toStartWith("1001\n1002\n");
    expect(result.content).toEndWith(
      `3000\n\n[Showing lines 1001-3000 of 3000. ${BASH_OUTPUT} with id 1 and an offset reads the rest.]`,
    );
    expect((result.details as BashDetails).truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 3000,
      outputLines: 2000,
    });
    const log = readFileSync(join(dir, "1.log"), "utf8");
    expect(log).toBe(`${Array.from({ length: 3000 }, (_, i) => i + 1).join("\n")}\n`);
  });

  // Regression tests for https://github.com/earendil-works/pi/issues/9577
  test("maps signal-killed commands to 128 plus the signal number", async () => {
    const folder = await tempFolder();
    const operations = createLocalBashOperations();
    for (const { signal, exitCode } of [
      { signal: "KILL", exitCode: 137 },
      { signal: "TERM", exitCode: 143 },
    ]) {
      const result = await operations.exec(`kill -${signal} $$`, folder, { onData: () => {} });
      expect(result.exitCode).toBe(exitCode);
    }
  });

  test("reports signal-killed commands as errors while preserving partial output", async () => {
    const { tool } = await setup();
    for (const { signal, exitCode } of [
      { signal: "KILL", exitCode: 137 },
      { signal: "TERM", exitCode: 143 },
    ]) {
      const result = await bash(tool, { command: `printf 'before-kill\\n'; kill -${signal} $$` });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(
        new RegExp(`before-kill\\s+Command exited with code ${exitCode}$`),
      );
    }
  });

  test("rejects a null exit code from custom operations", async () => {
    const { tool } = await setup({
      operations: fake(async (_command, _cwd, { onData }) => {
        onData(Buffer.from("partial\n", "utf-8"));
        return { exitCode: null };
      }),
    });
    const result = await bash(tool, { command: "remote" });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/partial\s+Command terminated without an exit code$/);
  });

  test("respects its timeout", async () => {
    const { tool } = await setup();
    const result = await bash(tool, { command: "sleep 5", timeout: 1, wait: true });
    expect(result).toMatchObject({ content: "Command timed out after 1 seconds", isError: true });
  });

  test("keeps a timed-out command's cut tail, pointing at bash_output", async () => {
    const { tool } = await setup({
      operations: fake(async (_command, _cwd, { onData, signal }) => {
        for (let i = 1; i <= 3000; i++) onData(Buffer.from(`${i}\n`, "utf-8"));
        await new Promise((resolve) => signal?.addEventListener("abort", resolve));
        throw new Error("aborted");
      }),
    });
    const result = await bash(tool, { command: "chatty-fail", timeout: 1, wait: true });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      `[Showing lines 1001-3000 of 3000. ${BASH_OUTPUT} with id 1 and an offset reads the rest.]`,
    );
    expect(result.content).toEndWith("Command timed out after 1 seconds");
  });

  test("reports a working directory that doesn't exist", async () => {
    const jobs = await BashJobs.open(await tempFolder());
    const missing = join(await tempFolder(), "gone");
    const result = await bash(createBashTool(folderGuard(missing), jobs), { command: "echo test" });
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      `Couldn't run the command: Working directory does not exist: ${missing}\nCannot execute bash commands.`,
    );
  });

  test("doesn't count a trailing newline as an extra truncated line", async () => {
    const { tool } = await setup({
      operations: fake(async (_command, _cwd, { onData }) => {
        for (let i = 1; i <= 4000; i++) {
          onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
        }
        return { exitCode: 0 };
      }),
    });
    const result = await bash(tool, { command: "many-lines" });
    expect((result.details as BashDetails).truncation).toMatchObject({
      totalLines: 4000,
      outputLines: 2000,
    });
    expect(result.content).toContain("line-2001");
    expect(result.content).toContain("line-4000");
    expect(result.content).toMatch(/\[Showing lines 2001-4000 of 4000\. /);
    expect(result.content).not.toContain("4001");
  });

  // #12062: a short line followed by one line far past the limit returned no output at all.
  test("shows the end of an over-long last line after a short line", async () => {
    const longLine = `${"y".repeat(219_000)}END`;
    const { tool } = await setup({
      operations: fake(async (_command, _cwd, { onData }) => {
        const data = Buffer.from(`first line\n${longLine}\n`, "utf-8");
        for (let i = 0; i < data.length; i += 8192) onData(data.subarray(i, i + 8192));
        return { exitCode: 0 };
      }),
    });
    const result = await bash(tool, { command: "grep -n x bundle.min.js" });
    expect((result.details as BashDetails).truncation?.lastLinePartial).toBe(true);
    expect(result.content).toContain("yyyyEND");
    expect(result.content).toMatch(/\[Showing the last 50\.0KB of line 2, which is 213\.9KB\. /);
  });

  test("says where the rest is, not (no output), when only a blank last line fits", async () => {
    const { tool } = await setup({
      operations: fake(async (_command, _cwd, { onData }) => {
        onData(Buffer.from(`${"y".repeat(60_000)}\n\n`, "utf-8"));
        return { exitCode: 0 };
      }),
    });
    const result = await bash(tool, { command: "curl -s https://example.com/data.json; echo" });
    expect(result.content).toBe(
      `\n\n[Showing lines 2-2 of 2 (50.0KB limit). ${BASH_OUTPUT} with id 1 and an offset reads the rest.]`,
    );
  });

  test("decodes UTF-8 characters split across output chunks", async () => {
    const euro = Buffer.from("€\n", "utf-8");
    const { tool } = await setup({
      operations: fake(async (_command, _cwd, { onData }) => {
        onData(euro.subarray(0, 1));
        onData(euro.subarray(1));
        return { exitCode: 0 };
      }),
    });
    expect((await bash(tool, { command: "split-utf8" })).content.trim()).toBe("€");
  });

  test("strips colours and CRLF, as pi's user bash does", async () => {
    const { tool } = await setup();
    const result = await bash(tool, { command: "printf '\\033[31mred\\033[0m\\r\\n'" });
    expect(result.content).toBe("red\n");
  });
});

describe.skipIf(posix)("bash's environment, input and output", () => {
  test("starts in the task's folder", async () => {
    const { tool, folder } = await setup();
    expect((await bash(tool, { command: "pwd -P" })).content).toBe(`${folder}\n`);
  });

  test("gets only the cut environment: no key the server holds, and TERM=dumb", async () => {
    const { tool } = await setup();
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      const result = await bash(tool, { command: "env" });
      const names = result.content
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0] as string);
      const allowed = new Set([
        "PATH",
        "HOME",
        "USER",
        "SHELL",
        "LANG",
        "TMPDIR",
        "TERM",
        "SSH_AUTH_SOCK",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
        // bash's own.
        "PWD",
        "SHLVL",
        "_",
      ]);
      expect(names.filter((name) => !allowed.has(name) && !name.startsWith("LC_"))).toEqual([]);
      expect(result.content).toContain("TERM=dumb\n");
      expect(result.content).not.toContain("sk-or-test");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  test("has no input: cat returns at once", async () => {
    const { tool } = await setup();
    const result = await bash(tool, { command: "cat; echo cat-done", wait: true, timeout: 5 });
    expect(result.content).toBe("cat-done\n");
  });

  test("has no terminal: opening /dev/tty fails rather than waiting", async () => {
    const { tool } = await setup();
    const result = await bash(tool, { command: "(exec 3</dev/tty)", timeout: 5 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("/dev/tty");
  });

  test("shows a progress bar's last state, and binary output as a note", async () => {
    const { tool } = await setup();
    expect((await bash(tool, { command: "printf '\\033[31mred\\033[0m'" })).content).toBe("red");
    expect((await bash(tool, { command: "printf 'a\\rb\\rc\\n'" })).content).toBe("c\n");
    expect((await bash(tool, { command: "printf 'a\\0b'" })).content).toBe(
      `(binary output: 3B, not shown; ${BASH_OUTPUT} with id 3 and an offset pages it as text)`,
    );
  });

  test("kills a command whose output passes the cap, keeping the cap's worth in its log", async () => {
    const { tool, dir } = await setup({ outputCapBytes: 64 * 1024 });
    const result = await bash(tool, { command: "yes", wait: true, timeout: 20 });
    expect(result.isError).toBe(true);
    expect(result.content).toEndWith(
      "Command stopped: its output passed 64KB. Send big output to a file in the task's folder " +
        "(command > out.log), then read or grep the file.",
    );
    expect(statSync(join(dir, "1.log")).size).toBe(64 * 1024);
    expect(statSync(join(dir, "1.log")).mode & 0o777).toBe(0o600);
  });
});

describe("bash's arguments", () => {
  test("refuses an empty command, and a timeout under a second, as invalid", async () => {
    const { tool } = await setup();
    const empty = await bash(tool, { command: "  \n" });
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain("command: must not be empty");
    const zero = await bash(tool, { command: "true", timeout: 0 });
    expect(zero.content).toContain("timeout: must be 1 or more");
    const notBoolean = await bash(tool, { command: "true", wait: "soon" });
    expect(notBoolean.content).toContain("wait: expected boolean, got string");
  });

  test.skipIf(posix)("cuts a timeout past 30 minutes to 30, and says so", async () => {
    const { tool } = await setup();
    const result = await bash(tool, { command: "echo ok", timeout: 3600 });
    expect(result.content).toBe("ok\n\n\n[timeout cut to 1800 s, the longest a command may run.]");
  });

  test("refuses a command whose JSON passes 12KB, before anything runs", async () => {
    const ran: string[] = [];
    const { tool } = await setup({
      operations: fake(async (command) => {
        ran.push(command);
        return { exitCode: 0 };
      }),
    });
    // Each CJK character is three bytes of UTF-8, and JSON leaves it as it is.
    const longest = `echo ${"汉".repeat((MAX_COMMAND_BYTES - 7) / 3)}`.slice(0, -1);
    const over = `echo ${"x".repeat(MAX_COMMAND_BYTES)}`;
    expect(Buffer.byteLength(JSON.stringify(longest))).toBeLessThanOrEqual(MAX_COMMAND_BYTES);
    expect(bashCommand({ command: longest })).toBe(longest);
    expect(bashCommand({ command: over })).toBeNull();
    const refused = await bash(tool, { command: over });
    expect(refused).toEqual({
      content:
        "This command is too long to show the owner. Write a script with write, then run it.",
      isError: true,
    });
    expect(ran).toEqual([]);
    await bash(tool, { command: longest });
    expect(ran).toEqual([longest]);
  });

  test("gives the card the timeout the call runs with: its own, capped, or the default", () => {
    expect([
      bashTimeoutSeconds({}),
      bashTimeoutSeconds({ timeout: 30 }),
      bashTimeoutSeconds({ timeout: 3600 }),
      bashTimeoutSeconds({ timeout: 0 }),
    ]).toEqual([120, 30, 1800, 120]);
  });

  test("runs the command trimmed, as bashCommand gives it to the gate", async () => {
    const ran: string[] = [];
    const { tool } = await setup({
      operations: fake(async (command) => {
        ran.push(command);
        return { exitCode: 0 };
      }),
    });
    await bash(tool, { command: "  npm test\n" });
    expect(ran).toEqual(["npm test"]);
    expect(bashCommand({ command: "  npm test\n" })).toBe("npm test");
    expect([bashCommand({}), bashCommand({ command: 3 }), bashCommand({ command: " " })]).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("names bash_output and the id in the stub that masks its result", async () => {
    const { tool } = await setup();
    expect(tool.elided?.({ id: 3, background: false }, 8120)).toBe(
      "[Result elided to save context: bash command 3 returned 8120 characters. bash_output " +
        "with id 3 shows its output; don't run the command again to see it.]",
    );
    expect(tool.elided?.(undefined, 8120)).toBeUndefined();
  });

  test("never runs again on its own after a restart, and runs one call at a time", async () => {
    const { tool } = await setup();
    expect([tool.replay, tool.executionMode]).toEqual(["never", "sequential"]);
  });
});

describe.skipIf(posix)("real process-group kills", () => {
  test("a call's abort kills the shell and what it started, within a second", async () => {
    const { tool, dir } = await setup();
    const controller = new AbortController();
    const call = bash(
      tool,
      { command: "echo $$; sleep 300 & echo $!; wait", wait: true },
      {
        signal: controller.signal,
      },
    );
    const [shell, sleep] = (await pidsIn(join(dir, "1.log"), 2)) as [number, number];
    controller.abort();
    expect((await call).isError).toBe(true);
    expect(await deadWithin(shell, 1000)).toBe(true);
    expect(await deadWithin(sleep, 1000)).toBe(true);
  });

  test("a call's abort that lands while the shell starts still kills it", async () => {
    const call = new AbortController();
    const local = createLocalBashOperations();
    // The abort lands while exec checks the folder, before the shell is spawned: where a Stop
    // lands when the folder's stat is slow, as on a network share.
    const { tool, dir } = await setup({
      operations: {
        exec(command, cwd, options) {
          const running = local.exec(command, cwd, options);
          call.abort();
          return running;
        },
      },
    });
    const started = Date.now();
    const result = await bash(
      tool,
      { command: "sleep 2; echo still-ran", timeout: 1, wait: true },
      { signal: call.signal },
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ content: "Command aborted", isError: true });
    expect(readFileSync(join(dir, "1.log"), "utf8")).toBe("");
  });

  test("a timeout kills the shell and what it started", async () => {
    const { tool, dir } = await setup();
    const result = bash(tool, {
      command: "echo $$; sleep 300 & echo $!; wait",
      timeout: 1,
      wait: true,
    });
    const [shell, sleep] = (await pidsIn(join(dir, "1.log"), 2)) as [number, number];
    expect(await result).toMatchObject({ isError: true });
    expect((await result).content).toEndWith("Command timed out after 1 seconds");
    expect(await deadWithin(shell, 1000)).toBe(true);
    expect(await deadWithin(sleep, 1000)).toBe(true);
  });

  test("what a command leaves running dies when it exits, and its call doesn't wait for it", async () => {
    const { tool } = await setup();
    const started = Date.now();
    const result = await bash(tool, { command: "sleep 300 & echo $!", wait: true });
    expect(Date.now() - started).toBeLessThan(3000);
    const straggler = Number(result.content.trim());
    spawned.push(straggler);
    expect(await deadWithin(straggler, 1000)).toBe(true);
  });
});

describe.skipIf(posix)("wait", () => {
  test("keeps the call open past the yield and returns the command's own output", async () => {
    const { tool, jobs } = await setup({ yieldMs: 200 });
    const result = await bash(tool, { command: "sleep 1; echo done", wait: true });
    expect(result.content).toBe("done\n");
    expect(result.details).toMatchObject({ background: false, end: "exit" });
    expect(jobs.running()).toBe(false);
    expect(jobs.takeEnded()).toEqual([]);
  });

  test("without it, a command still running at the yield moves to the background", async () => {
    const { tool, jobs } = await setup({ yieldMs: 200 });
    const result = await bash(tool, { command: "echo started; sleep 1; echo done" });
    expect(result.content).toBe(
      "Command 1 is still running after 0.2 s, so it moved to the background. Its output so " +
        "far:\n\nstarted\n\n\nYou're told when it ends, and the task doesn't end before it does. " +
        "It is killed if it still runs 120 s after it started. bash_output with id 1 shows what " +
        "it prints, and bash_kill stops it.",
    );
    expect(result.details).toEqual({ id: 1, background: true });
    expect(jobs.running()).toBe(true);
    await jobs.killAll("stopped");
  });

  test("a steering line moves a waited-on command to the background within its poll", async () => {
    const { tool, jobs } = await setup({ yieldMs: 200, pollMs: 50 });
    let steering = false;
    setTimeout(() => {
      steering = true;
    }, 300);
    const started = Date.now();
    const result = await bash(
      tool,
      { command: "sleep 30", wait: true },
      { steered: () => steering },
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.content).toStartWith(
      "Command 1 is still running, and a message came in, so it moved to the background. It " +
        "has printed nothing so far.",
    );
    expect(jobs.background().map((command) => command.id)).toEqual([1]);
    await jobs.killAll("stopped");
  });
});
