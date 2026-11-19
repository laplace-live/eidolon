// A task's commands past their calls: the move to the background, the notices of how each ended,
// bash_output and bash_kill, the background limit, and what a stop or a crash leaves for the next
// run. Real processes, on POSIX.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBashKillTool,
  createBashOutputTool,
  createLocalBashOperations,
} from "../src/tools/bash.ts";
import { type BackgroundCommand, BashJobs, type BashJobsOptions } from "../src/tools/jobs.ts";
import { bashOffered } from "../src/tools/shell.ts";
import type { PathGuard } from "../src/types.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

const spawned: number[] = [];

afterAll(async () => {
  // A failed kill test would leave its sleep 300 running: these are this file's own.
  for (const pid of spawned) if (alive(pid)) process.kill(pid, "SIGKILL");
  await removeTempFolders();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(done: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !done(); await Bun.sleep(20)) {
    if (Date.now() > end) throw new Error("Timed out waiting");
  }
}

async function deadWithin(pid: number, ms: number): Promise<boolean> {
  try {
    await until(() => !alive(pid), ms);
    return true;
  } catch {
    return false;
  }
}

interface Setup {
  /** The task's records: the registry keeps its files in bash/ there. */
  readonly records: string;
  readonly dir: string;
  readonly guard: PathGuard;
  readonly jobs: BashJobs;
}

async function setup(options: BashJobsOptions = {}): Promise<Setup> {
  const records = await tempFolder();
  return {
    records,
    dir: join(records, "bash"),
    guard: folderGuard(await tempFolder()),
    jobs: await BashJobs.open(records, { yieldMs: 200, ...options }),
  };
}

function start(
  { jobs, guard }: Setup,
  command: string,
  more: { timeoutMs?: number; wait?: boolean; signal?: AbortSignal; steered?: () => boolean } = {},
) {
  return jobs.run(command, {
    guard,
    timeoutMs: more.timeoutMs ?? 10_000,
    wait: more.wait ?? false,
    signal: more.signal ?? new AbortController().signal,
    ...(more.steered === undefined ? {} : { steered: more.steered }),
  });
}

/** The pids a command printed into its log, once there are `count`. */
async function pidsIn(log: string, count: number): Promise<number[]> {
  let pids: number[] = [];
  await until(() => {
    let text = "";
    try {
      text = readFileSync(log, "utf8");
    } catch {}
    pids = text.split("\n").filter(Boolean).map(Number);
    return pids.length >= count;
  });
  spawned.push(...pids);
  return pids;
}

describe.skipIf(!bashOffered())("BashJobs", () => {
  test("past the yield the call returns, the run waits, and the end comes once, without output", async () => {
    const setup_ = await setup();
    const { jobs } = setup_;
    const result = await start(setup_, "echo kept-out; sleep 0.6");
    expect(result.content).toStartWith(
      "Command 1 is still running after 0.2 s, so it moved to the background. Its output so " +
        "far:\n\nkept-out\n",
    );
    expect(jobs.running()).toBe(true);
    expect(jobs.takeEnded()).toEqual([]);
    await until(() => !jobs.running());
    const notices = jobs.takeEnded();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(
      /^\[Command 1 ended with code 0 after [\d.]+ s\. bash_output with id 1 shows its output\.\]$/,
    );
    expect(notices[0]).not.toContain("kept-out");
    expect(jobs.takeEnded()).toEqual([]);
  });

  test("bash_output shows the latest output, pages it, and marks an end seen", async () => {
    const setup_ = await setup();
    const { jobs } = setup_;
    const output = createBashOutputTool(jobs);
    await start(setup_, "for i in 1 2 3 4 5; do echo line-$i; done; sleep 0.5; echo last");
    const running = await output.execute({ id: 1 }, toolContext());
    expect(running.content).toMatch(
      /^Command 1 is running in the background, for [\d.]+ s so far; it is killed at 10 s\.\n\nline-1\nline-2\nline-3\nline-4\nline-5\n$/,
    );
    await until(() => !jobs.running());
    const page = await output.execute({ id: 1, offset: 2, limit: 2 }, toolContext());
    expect(page.content).toMatch(
      /^Command 1 ended with code 0 after [\d.]+ s\.\n\nline-2\nline-3\n\n\[/,
    );
    expect(page.content).toContain("Use offset=4 to continue.]");
    const last = await output.execute({ id: 1, limit: 2 }, toolContext());
    expect(last.content).toEndWith(
      "\n\nline-5\nlast\n\n[Showing lines 5-6 of 6. An offset reads the rest.]",
    );
    expect(jobs.takeEnded()).toEqual([]);
  });

  test("bash_kill kills a command's whole group and marks its end seen", async () => {
    const setup_ = await setup();
    const { jobs, dir } = setup_;
    await start(setup_, "echo $$; sleep 300 & echo $!; wait");
    const [shell, sleep] = (await pidsIn(join(dir, "1.log"), 2)) as [number, number];
    const killed = await createBashKillTool(jobs).execute({ id: 1 }, toolContext());
    expect(killed.content).toMatch(
      /^Command 1 was stopped with bash_kill after [\d.]+ s\.\n\n\d+\n\d+\n$/,
    );
    expect(await deadWithin(shell, 1000)).toBe(true);
    expect(await deadWithin(sleep, 1000)).toBe(true);
    expect(jobs.running()).toBe(false);
    expect(jobs.takeEnded()).toEqual([]);
    const again = await createBashKillTool(jobs).execute({ id: 1 }, toolContext());
    expect(again.content).toStartWith("Command 1 was stopped with bash_kill");
  });

  test("with 4 in the background another command runs, but one past the yield is stopped", async () => {
    const setup_ = await setup();
    const { jobs } = setup_;
    for (let i = 0; i < 4; i++) await start(setup_, "sleep 30");
    expect(jobs.background().map((command) => command.id)).toEqual([1, 2, 3, 4]);
    const quick = await start(setup_, "echo hi");
    expect(quick.content).toBe("hi\n");
    const stopped = await start(setup_, "echo slow; sleep 30");
    expect(stopped.isError).toBe(true);
    expect(stopped.content).toBe(
      "slow\n\n\nCommand 6 was stopped rather than moved to the background, where 4 commands " +
        "already run (ids 1, 2, 3 and 4). Stop one with bash_kill, or wait for one to end, before " +
        "you run it again.",
    );
    expect(jobs.background()).toHaveLength(4);
    expect(jobs.takeEnded()).toEqual([]);
    await jobs.killAll("stopped");
  });

  test("with 4 in the background, a steering line waits for a command's end or the yield", async () => {
    const setup_ = await setup({ yieldMs: 1000, pollMs: 50 });
    const { jobs } = setup_;
    for (let i = 0; i < 4; i++) await start(setup_, "sleep 30", { steered: () => true });
    expect(jobs.background().map((command) => command.id)).toEqual([1, 2, 3, 4]);
    let line = false;
    setTimeout(() => {
      line = true;
    }, 100);
    // A test run the owner allowed, which ends before the yield: the line costs it nothing.
    const tests = await start(setup_, "sleep 0.5; echo tests-passed", {
      wait: true,
      steered: () => line,
    });
    expect(tests).toMatchObject({ content: "tests-passed\n", details: { id: 5, end: "exit" } });
    // A waited one still running at the yield runs to its end, as it would without the line.
    const built = await start(setup_, "sleep 1.5; echo built", { wait: true, steered: () => true });
    expect(built).toMatchObject({ content: "built\n", details: { id: 6, end: "exit" } });
    // One not waited on is stopped at the yield, as without a steering line.
    const started = Date.now();
    const slow = await start(setup_, "sleep 30", { steered: () => true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(slow.content).toBe(
      "Command 7 was stopped rather than moved to the background, where 4 commands already run " +
        "(ids 1, 2, 3 and 4). Stop one with bash_kill, or wait for one to end, before you run it " +
        "again.",
    );
    expect(jobs.background()).toHaveLength(4);
    await jobs.killAll("stopped");
  });

  test("the server's stop while a command's shell starts kills it, moving nothing to the background", async () => {
    const local = createLocalBashOperations();
    let stopping: Promise<void> | undefined;
    // The stop lands while exec checks the folder, before the shell is spawned: where it lands
    // when the folder's stat is slow, as on a network share.
    const setup_ = await setup({
      operations: {
        exec(command, cwd, options) {
          const running = local.exec(command, cwd, options);
          stopping = setup_.jobs.killAll("shutdown");
          return running;
        },
      },
    });
    const started = Date.now();
    const result = await start(setup_, "sleep 2.5");
    await stopping;
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.content).toBe("Command stopped: Eidolon is stopping");
    expect(setup_.jobs.background()).toEqual([]);
  });

  test("a command stopped as it would move to the background ends in its call", async () => {
    // A kill that takes 0.4 s, as a sandbox's can: the yield comes before the command is gone.
    const setup_ = await setup({
      operations: {
        exec: (_command, _cwd, { signal }) =>
          new Promise((_resolve, reject) => {
            const fail = () => setTimeout(() => reject(new Error("aborted")), 400);
            signal?.addEventListener("abort", fail, { once: true });
          }),
      },
    });
    const result = start(setup_, "sleep 30");
    await Bun.sleep(100);
    const stopping = setup_.jobs.killAll("shutdown");
    expect(await result).toMatchObject({
      content: "Command stopped: Eidolon is stopping",
      isError: true,
      details: { id: 1, background: false, end: "shutdown" },
    });
    expect(setup_.jobs.background()).toEqual([]);
    await stopping;
  });

  test("a timeout past the yield kills the command, and its notice says so", async () => {
    const setup_ = await setup();
    const { jobs } = setup_;
    await start(setup_, "sleep 30", { timeoutMs: 1000 });
    expect(jobs.running()).toBe(true);
    await until(() => !jobs.running());
    expect(jobs.takeEnded()).toEqual([
      "[Command 1 was killed at its timeout of 1 s. bash_output with id 1 shows its output.]",
    ]);
  });

  test("a stop ends every command, and the next start hears of those in the background only", async () => {
    const setup_ = await setup();
    const { jobs, dir, records } = setup_;
    await start(setup_, "sleep 30");
    const foreground = start(setup_, "sleep 30", { wait: true });
    await until(() => readFileSync(join(dir, "runs.json"), "utf8").includes('"id": 2'));
    await jobs.killAll("shutdown");
    expect((await foreground).content).toBe("Command stopped: Eidolon is stopping");
    expect(await start(setup_, "echo late")).toEqual({
      content: "Commands can't start now: the task is stopping.",
      isError: true,
    });

    const next = await BashJobs.open(records);
    expect(next.takeEnded()).toEqual([
      "[Command 1 was stopped when Eidolon stopped; run it again if it's still needed.]",
    ]);
    expect(next.takeEnded()).toEqual([]);
    await next.flush();
    expect((await BashJobs.open(records)).takeEnded()).toEqual([]);
  });

  test("a command a dead server left running is lost, told only if it was in the background", async () => {
    const records = await tempFolder();
    const dir = join(records, "bash");
    const run = (id: number, background: boolean) => ({
      id,
      command: "npm run dev",
      startedAt: 1,
      timeoutMs: 120_000,
      background,
    });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "runs.json"),
      JSON.stringify({ v: 1, runs: [run(1, true), run(2, false)] }),
    );
    const jobs = await BashJobs.open(records);
    expect(jobs.running()).toBe(false);
    expect(jobs.background()).toEqual([]);
    expect(jobs.takeEnded()).toEqual([
      "[Eidolon lost track of command 1 when it stopped without warning; it may still be running and holding its ports.]",
    ]);
    const state = await createBashOutputTool(jobs).execute({ id: 1 }, toolContext());
    expect(state.content).toBe(
      "Eidolon lost track of command 1 when it stopped without warning; it may still be " +
        "running.\n\n(no output)",
    );
  });

  test("ids go on across opens, from the logs when runs.json is damaged", async () => {
    const setup_ = await setup();
    const { dir, records } = setup_;
    await start(setup_, "true");
    await start(setup_, "true");
    await setup_.jobs.flush();
    const reopened = { ...setup_, jobs: await BashJobs.open(records) };
    expect((await start(reopened, "echo three")).details).toMatchObject({ id: 3 });
    await reopened.jobs.flush();
    writeFileSync(join(dir, "runs.json"), "not json");
    const damaged = { ...setup_, jobs: await BashJobs.open(records) };
    expect((await start(damaged, "echo four")).details).toMatchObject({ id: 4 });
  });

  test("onChange lists the background commands each time they change", async () => {
    const lists: (readonly BackgroundCommand[])[] = [];
    const setup_ = await setup({ onChange: (list) => lists.push(list) });
    await start(setup_, "sleep 0.5", { timeoutMs: 60_000 });
    await until(() => lists.length === 2);
    expect(lists[0]).toEqual([
      {
        id: 1,
        command: "sleep 0.5",
        startedAt: expect.any(Number),
        endsAt: (lists[0]?.[0]?.startedAt ?? 0) + 60_000,
      },
    ]);
    expect(lists[1]).toEqual([]);
  });

  test("a run that was left sees nothing running and takes no ends, which wait for the next", async () => {
    const setup_ = await setup();
    const { jobs } = setup_;
    const left = new AbortController();
    const run = jobs.forRun(left.signal);
    await start(setup_, "sleep 0.4");
    expect(run.running()).toBe(true);
    left.abort();
    expect(run.running()).toBe(false);
    await until(() => !jobs.running());
    expect(run.takeEnded()).toEqual([]);
    expect(jobs.forRun(new AbortController().signal).takeEnded()).toHaveLength(1);
  });

  test("keeps its folder 0700 and its files 0600", async () => {
    const setup_ = await setup();
    const { dir } = setup_;
    await start(setup_, "echo private");
    await setup_.jobs.flush();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "runs.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "1.log")).mode & 0o777).toBe(0o600);
  });

  test("bash_output and bash_kill name what they can't find, and check their arguments", async () => {
    const setup_ = await setup();
    const { jobs } = setup_;
    const output = createBashOutputTool(jobs);
    expect((await output.execute({ id: 5 }, toolContext())).content).toBe(
      "This task has run no commands yet.",
    );
    await start(setup_, "true");
    expect(await createBashKillTool(jobs).execute({ id: 5 }, toolContext())).toEqual({
      content: "No command has id 5: this task's ids run from 1 to 1.",
      isError: true,
    });
    expect((await output.execute({}, toolContext())).content).toContain("id: missing");
    expect((await output.execute({ id: 1, offset: 0 }, toolContext())).content).toContain(
      "offset: must be 1 or more",
    );
  });
});
