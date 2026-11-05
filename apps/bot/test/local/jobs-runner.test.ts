// The job runner over a fake CLI: events and stderr in files, snapshots reduced from them, a crash
// told by its missing summary, cancelling, the stop hook, what a restart finds, and retention.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataHome } from "@eidolon/config";
import type { JobCommand, JobStatus } from "../../src/local/api.ts";
import type { JobSpec } from "../../src/local/jobs/argv.ts";
import { type Job, JobRunner, type JobRunnerOptions } from "../../src/local/jobs/runner.ts";
import { JOB_ID, jobFiles, jobsDir, type StoredJob } from "../../src/local/jobs/store.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type FakeCli, fakeCli, isAlive, until } from "./jobs-harness.ts";

let logs: CapturedLogs;
let cli: FakeCli;
const runners: JobRunner[] = [];

beforeEach(() => {
  logs = captureLogs();
  cli = fakeCli();
});

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  logs.restore();
  rmSync(dataHome(), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(dataHome(), { recursive: true, force: true });
});

function runner(options: Omit<JobRunnerOptions, "argv"> = {}): JobRunner {
  const created = new JobRunner({ argv: cli.argv, pollMs: 20, ...options });
  runners.push(created);
  return created;
}

function spec(command: JobCommand = "ingest-facts", persona = "milky-green"): JobSpec {
  const cliCommand = command === "plan" ? "pipeline" : command === "expand" ? "download" : command;
  const args = ["--persona", persona, ...(command === "plan" ? ["--dry-run"] : [])];
  return { command, persona, options: {}, cli: cliCommand, args };
}

function start(jobs: JobRunner, scenario: string, command: JobCommand = "ingest-facts"): Job {
  cli.scenario = scenario;
  return jobs.start(spec(command));
}

/** The message of the job's first event, where the fake CLI reports what it saw. */
function firstMessage(job: Job): string {
  const [line] = readFileSync(jobFiles(job.record.id).events, "utf8").split("\n");
  return (JSON.parse(line as string) as { message: string }).message;
}

describe("a job's run", () => {
  test("writes its events and stderr to its own private files, and ends by its summary", async () => {
    const jobs = runner();
    const job = start(jobs, "ok");
    expect(job.record.id).toMatch(JOB_ID);
    await job.ended;
    const files = jobFiles(job.record.id);
    for (const path of [files.events, files.log]) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(jobsDir()).mode & 0o777).toBe(0o700);
    const snapshot = jobs.snapshot(job);
    expect(snapshot).toMatchObject({
      command: "ingest-facts",
      persona: "milky-green",
      status: "succeeded",
      exitCode: 0,
      ephemeral: false,
      stopping: false,
      resumedFrom: null,
      resumedBy: null,
      failures: [],
      eventsSize: statSync(files.events).size,
    });
    expect(snapshot.stages).toEqual([
      {
        stage: "ingest-facts",
        status: "done",
        done: 2,
        failed: 0,
        skipped: 0,
        total: 2,
        progress: null,
      },
    ]);
    expect(snapshot.stderrTail).toContain("fake CLI ok ingest-facts");
    expect("pid" in snapshot).toBe(false);
    // The record on disk holds the pid, for a later server to check on.
    const stored = JSON.parse(readFileSync(files.record, "utf8")) as StoredJob;
    expect(stored).toMatchObject({ status: "succeeded", exitCode: 0, pid: job.record.pid });
    expect(stored.pid).toBeGreaterThan(1);
  });

  test("runs the CLI's argv in the data home, detached in a process group of its own", async () => {
    const jobs = runner();
    const job = start(jobs, "slow");
    const pid = job.record.pid as number;
    // A group whose id is the child's pid exists only if the child leads one.
    expect(() => process.kill(-pid, 0)).not.toThrow();
    jobs.cancel(job);
    await job.ended;
    cli.scenario = "echo";
    const echo = jobs.start(spec("refine", "milky-green"));
    await echo.ended;
    const said = JSON.parse(firstMessage(echo)) as { argv?: string[]; cwd?: string };
    expect(said.cwd).toBe(realpathSync(dataHome()));
    expect(said.argv).toEqual(["refine", "--json", "--persona", "milky-green"]);
    expect(cli.calls.at(-1)).toEqual(["refine", "--persona", "milky-green"]);
  });

  test("a snapshot counts items once, adds the cost so far, and lists what still failed", async () => {
    const jobs = runner();
    const job = start(jobs, "costs", "pipeline");
    await job.ended;
    const snapshot = jobs.snapshot(job);
    expect(snapshot.stages).toEqual([
      {
        stage: "download",
        status: "done",
        done: 1,
        failed: 0,
        skipped: 0,
        total: 1,
        progress: null,
      },
      {
        stage: "transcribe",
        status: "failed",
        done: 1,
        failed: 1,
        skipped: 1,
        total: 3,
        progress: null,
      },
      {
        stage: "ingest-streams",
        status: "start",
        done: 0,
        failed: 0,
        skipped: 0,
        total: null,
        progress: { done: 3, total: 9, unit: "chunks" },
      },
    ]);
    // The download's retried URL succeeded, so only the transcription and its stage are listed.
    expect(snapshot.failures).toEqual([
      {
        stage: "transcribe",
        item: "v3.m4a",
        video: "v3",
        code: "insufficient-credits",
        provider: "soniox",
        message: "402 Payment Required",
      },
      {
        stage: "transcribe",
        item: null,
        video: null,
        code: "insufficient-credits",
        provider: "soniox",
        message: null,
      },
    ]);
    expect(snapshot.costUsd).toBeCloseTo(0.3, 10);
  });

  test("lists the first 100 failures, while the stage counts every one", async () => {
    const jobs = runner();
    const job = start(jobs, "many-failures");
    await job.ended;
    const snapshot = jobs.snapshot(job);
    expect(snapshot.failures).toHaveLength(100);
    expect(snapshot.failures[0]).toMatchObject({ item: "f0", message: "bad 0" });
    expect(snapshot.stages[0]).toMatchObject({ failed: 150, status: "failed" });
    expect(snapshot.status).toBe("failed");
  });

  test("a run that dies without its summary failed, and its stderr's tail says why", async () => {
    const jobs = runner();
    const job = start(jobs, "crash");
    await job.ended;
    const snapshot = jobs.snapshot(job);
    expect(snapshot).toMatchObject({ status: "failed", exitCode: 1 });
    const tail = snapshot.stderrTail.split("\n");
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe("trace line 22");
    expect(tail.at(-1)).toBe("TypeError: boom");
  });

  test("plans and previews are ephemeral", async () => {
    const jobs = runner();
    const plan = start(jobs, "plan", "plan");
    await plan.ended;
    expect(jobs.snapshot(plan)).toMatchObject({ ephemeral: true, status: "succeeded" });
  });
});

describe("cancelling", () => {
  test("sends one SIGTERM, which the CLI answers by cancelling its run", async () => {
    const jobs = runner();
    const job = start(jobs, "slow");
    await until(() => jobs.snapshot(job).stages.length > 0);
    expect(jobs.cancel(job)).toBe("stopping");
    expect(jobs.snapshot(job)).toMatchObject({ status: "running", stopping: true });
    // A second request must not send a second SIGTERM, which makes the CLI quit at once.
    expect(jobs.cancel(job)).toBe("stopping");
    await job.ended;
    const snapshot = jobs.snapshot(job);
    expect(snapshot).toMatchObject({ status: "cancelled", exitCode: 143, stopping: true });
    expect(snapshot.stderrTail).toContain("SIGTERM 1");
    expect(snapshot.stderrTail).not.toContain("SIGTERM 2");
    expect(jobs.cancel(job)).toBe("ended");
  });

  test("kills the whole process group when the job outlasts the grace period", async () => {
    const jobs = runner({ killAfterMs: 200 });
    const job = start(jobs, "stubborn");
    await until(() => jobs.snapshot(job).stages.length > 0);
    const grandchild = Number(firstMessage(job));
    expect(isAlive(grandchild)).toBe(true);
    jobs.cancel(job);
    await job.ended;
    expect(jobs.snapshot(job)).toMatchObject({ status: "cancelled", exitCode: 137 });
    await until(() => !isAlive(grandchild));
  });

  test("an events stream stops reading once its client goes away", async () => {
    const jobs = runner();
    const job = start(jobs, "slow");
    const reader = jobs.eventsStream(job, 0).getReader();
    await reader.read();
    expect(jobs.streaming).toBe(1);
    await reader.cancel();
    expect(jobs.streaming).toBe(0);
    jobs.cancel(job);
    await job.ended;
  });

  test("the stop hook sends SIGTERM to every running job and ends open streams", async () => {
    const jobs = runner();
    const job = start(jobs, "slow");
    await until(() => jobs.snapshot(job).stages.length > 0);
    const reader = jobs.eventsStream(job, 0).getReader();
    await reader.read();
    expect(jobs.streaming).toBe(1);
    await jobs.stop();
    expect(jobs.streaming).toBe(0);
    expect(jobs.snapshot(job).status).toBe("cancelled");
    for (;;) if ((await reader.read()).done) break;
  });
});

describe("what a restart finds", () => {
  let next = 0;

  /** A record as an earlier server left it, with events and a log. */
  function leave(fields: Partial<StoredJob>, events: object[] = []): StoredJob {
    next++;
    const record: StoredJob = {
      id: `20261105T1200${String(next).padStart(2, "0")}-ABCDEF`,
      command: "ingest-facts",
      persona: "milky-green",
      options: {},
      status: "running",
      startedAt: new Date(Date.UTC(2026, 10, 5, 12, 0, next)).toISOString(),
      endedAt: null,
      exitCode: null,
      ephemeral: false,
      resumedFrom: null,
      resumedBy: null,
      pid: null,
      ...fields,
    };
    const files = jobFiles(record.id);
    mkdirSync(jobsDir(), { recursive: true });
    writeFileSync(files.record, JSON.stringify(record));
    writeFileSync(files.events, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    writeFileSync(files.log, "earlier log\n");
    return record;
  }

  async function deadPid(): Promise<number> {
    const child = Bun.spawn(["true"]);
    await child.exited;
    return child.pid;
  }

  const SUMMARY = { type: "summary", stage: "ingest-facts", counts: {}, durationSec: 1 };

  function statusOf(jobs: JobRunner, id: string): JobStatus | undefined {
    const job = jobs.find(id);
    return job === undefined ? undefined : jobs.snapshot(job).status;
  }

  test("a running job whose process is gone ends as its summary says, else interrupted", async () => {
    const pid = await deadPid();
    const finished = leave({ pid }, [{ ...SUMMARY, ok: true }]);
    const cancelled = leave({ pid }, [{ ...SUMMARY, ok: false, cancelled: true }]);
    const cut = leave({ pid }, [{ type: "stage", stage: "ingest-facts", status: "start" }]);
    const unknown = leave({ pid: null });
    const init = leave({ pid: 1 });
    const ended = leave({
      status: "failed",
      endedAt: "2026-11-05T12:30:00.000Z",
      exitCode: 1,
      pid,
    });
    const when = new Date("2026-11-05T13:00:00.000Z");
    utimesSync(jobFiles(cut.id).events, when, when);
    utimesSync(jobFiles(cut.id).log, when, when);

    const jobs = runner();
    expect(statusOf(jobs, finished.id)).toBe("succeeded");
    expect(statusOf(jobs, cancelled.id)).toBe("cancelled");
    expect(statusOf(jobs, cut.id)).toBe("interrupted");
    expect(statusOf(jobs, unknown.id)).toBe("interrupted");
    expect(statusOf(jobs, init.id)).toBe("interrupted");
    expect(statusOf(jobs, ended.id)).toBe("failed");
    const record = JSON.parse(readFileSync(jobFiles(cut.id).record, "utf8")) as StoredJob;
    expect(record).toMatchObject({
      status: "interrupted",
      exitCode: null,
      endedAt: when.toISOString(),
    });
    expect(jobs.snapshot(jobs.find(ended.id) as Job).endedAt).toBe("2026-11-05T12:30:00.000Z");
  });

  test("a stale record naming a live, unrelated process: watched, never signalled", async () => {
    const stranger = Bun.spawn(["sleep", "30"]);
    try {
      const record = leave({ pid: stranger.pid });
      const jobs = runner();
      const job = jobs.find(record.id) as Job;
      expect(jobs.snapshot(job).status).toBe("running");
      expect(jobs.cancel(job)).toBe("not-ours");
      await Bun.sleep(60);
      expect(isAlive(stranger.pid)).toBe(true);
      stranger.kill();
      await stranger.exited;
      await until(() => jobs.snapshot(job).status !== "running");
      expect(jobs.snapshot(job).status).toBe("interrupted");
    } finally {
      stranger.kill();
    }
  });

  test("a job still running whose summary arrives ends by it", async () => {
    const stranger = Bun.spawn(["sleep", "30"]);
    try {
      const record = leave({ pid: stranger.pid });
      const jobs = runner();
      const job = jobs.find(record.id) as Job;
      writeFileSync(jobFiles(record.id).events, `${JSON.stringify({ ...SUMMARY, ok: true })}\n`);
      await until(() => jobs.snapshot(job).status !== "running");
      expect(jobs.snapshot(job).status).toBe("succeeded");
    } finally {
      stranger.kill();
    }
  });

  test("plans and previews are dropped, and files that aren't records are left alone", () => {
    const plan = leave({ command: "plan", ephemeral: true, status: "succeeded" });
    mkdirSync(jobsDir(), { recursive: true });
    writeFileSync(join(jobsDir(), "20261105T120000-ZZZZZZ.json"), "{ not json");
    writeFileSync(join(jobsDir(), "notes.json"), "{}");
    writeFileSync(join(jobsDir(), "20261105T120001-ABCDEF.json"), JSON.stringify({ id: "other" }));
    const jobs = runner();
    expect(jobs.list()).toEqual([]);
    for (const path of Object.values(jobFiles(plan.id))) expect(existsSync(path)).toBe(false);
    expect(readdirSync(jobsDir()).toSorted()).toEqual([
      "20261105T120000-ZZZZZZ.json",
      "20261105T120001-ABCDEF.json",
      "notes.json",
    ]);
    expect(logs.lines().filter((line) => line.startsWith("WARNING Skipping job"))).toHaveLength(2);
  });
});

describe("retention", () => {
  function ended(count: number): StoredJob[] {
    mkdirSync(jobsDir(), { recursive: true });
    return Array.from({ length: count }, (_, i) => {
      const at = new Date(Date.UTC(2026, 9, 1, 0, i));
      const record: StoredJob = {
        id: `${at.toISOString().replace(/[-:]/g, "").slice(0, 15)}-ABCDEF`,
        command: "refine",
        persona: "milky-green",
        options: {},
        status: "succeeded",
        startedAt: at.toISOString(),
        endedAt: at.toISOString(),
        exitCode: 0,
        ephemeral: false,
        resumedFrom: null,
        resumedBy: null,
        pid: null,
      };
      const files = jobFiles(record.id);
      writeFileSync(files.record, JSON.stringify(record));
      writeFileSync(files.events, "");
      writeFileSync(files.log, "");
      return record;
    });
  }

  test("keeps the newest 50 jobs, and drops each older one's files", async () => {
    const records = ended(55);
    const jobs = runner();
    expect(jobs.list().map((job) => job.id)).toEqual(
      records
        .slice(5)
        .map((record) => record.id)
        .toReversed(),
    );
    for (const record of records.slice(0, 5)) {
      for (const path of Object.values(jobFiles(record.id))) expect(existsSync(path)).toBe(false);
    }
    const job = start(jobs, "ok", "refine");
    await job.ended;
    const ids = jobs.list().map((snapshot) => snapshot.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe(job.record.id);
    expect(ids).not.toContain(records[5]?.id);
    expect(existsSync(jobFiles(records[5]?.id as string).record)).toBe(false);
  });

  test("plans and previews don't count, and only each persona's newest stays", async () => {
    mkdirSync(join(dataHome(), "personas", "alice"), { recursive: true });
    const jobs = runner({ keep: 1 });
    const first = start(jobs, "plan", "plan");
    await first.ended;
    cli.scenario = "plan";
    const other = jobs.start(spec("plan", "alice"));
    await other.ended;
    const durable = start(jobs, "ok", "refine");
    await durable.ended;
    const second = start(jobs, "plan", "plan");
    await second.ended;
    expect(jobs.list().map((job) => job.id)).toEqual(
      [second, durable, other].map((job) => job.record.id),
    );
    expect(existsSync(jobFiles(first.record.id).events)).toBe(false);
  });

  test("a running job is never dropped", async () => {
    const jobs = runner({ keep: 1 });
    const slow = start(jobs, "slow", "refine");
    const first = start(jobs, "ok", "refine");
    await first.ended;
    const second = start(jobs, "ok", "refine");
    expect(jobs.find(first.record.id)).toBeUndefined();
    expect(jobs.find(slow.record.id)).toBe(slow);
    expect(jobs.find(second.record.id)).toBe(second);
    jobs.cancel(slow);
    await Promise.all([slow.ended, second.ended]);
  });
});
