// The task manager on a scripted mind and temporary folders, with no network: how a task she starts
// runs, pauses, asks and ends, and is reported to its chat; what a restart, a cancel, the lock and
// Assistant Mode's switch do to it; and that laplace-task's tasks are never touched.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  newTaskId,
  openTaskStore,
  readSnapshot,
  type TaskChat,
  type TaskSnapshot,
  type TaskStatus,
  tasksDir,
  writeSnapshot,
} from "@eidolon/assistant";
import { type AssistantSettings, dataHome } from "@eidolon/config";
import { acquireLock } from "@eidolon/config/lock";
import type {
  createMind,
  MindChunk,
  MindRequest,
  MindToolCall,
  TaskEntry,
  TaskEntryDraft,
} from "@eidolon/engine";
import {
  ProviderConfigError,
  ProviderHttpError,
  reportUsage,
  type UsageRecord,
} from "@eidolon/providers";
import { STEER_PREFIX } from "../../src/local/api.ts";
import {
  TaskManager,
  type TaskManagerOptions,
  TaskRefused,
} from "../../src/local/tasks/manager.ts";
import { type CapturedLogs, captureLogs, deferred } from "../fakes.ts";

type Turn = readonly MindChunk[] | Error | ((request: MindRequest) => AsyncIterable<MindChunk>);

const DONE: MindChunk = { type: "done", finishReason: "stop" };

function says(text: string): MindChunk[] {
  return [{ type: "text", text }, DONE];
}

function calls(made: readonly MindToolCall[], text = ""): MindChunk[] {
  return [
    ...(text === "" ? [] : [{ type: "text", text } as const]),
    { type: "tool-calls", calls: made },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function call(id: string, name: string, args: Record<string, unknown>): MindToolCall {
  return { id, name, arguments: args };
}

/** A reply that waits for `open`, and fails as a request does once its signal aborts. */
function held(open: Promise<void>, then: readonly MindChunk[] = says("Done.")): Turn {
  return async function* (request) {
    await new Promise<void>((resolve, reject) => {
      if (request.signal.aborted) return reject(request.signal.reason);
      request.signal.addEventListener("abort", () => reject(request.signal.reason), {
        once: true,
      });
      void open.then(resolve);
    });
    yield* then;
  };
}

/**
 * createMind for every task: each request answered from its task's script, found by the goal in
 * the worker's prompt, and billed `cost` as the assistant, through the mind's tap as a real one is.
 */
class Minds {
  readonly made: { role: string; account?: string; model?: string }[] = [];
  readonly requests: { readonly goal: string; readonly request: MindRequest }[] = [];
  readonly records: UsageRecord[] = [];
  readonly #scripts = new Map<string, readonly Turn[]>();
  readonly #served = new Map<string, number>();
  /** Each request's cost: null for a model with no price. */
  cost: number | null = 0;
  /** What createMind throws instead of making a mind. */
  refuse: Error | null = null;

  script(goal: string, turns: readonly Turn[]): void {
    this.#scripts.set(goal, turns);
  }

  for(goal: string): MindRequest[] {
    return this.requests.filter((each) => each.goal === goal).map((each) => each.request);
  }

  readonly createMind: typeof createMind = (role = "mind", options = {}) => {
    if (this.refuse !== null) throw this.refuse;
    this.made.push({ role, account: options.account, model: options.model });
    const turnFor = (goal: string): Turn => {
      const at = this.#served.get(goal) ?? 0;
      this.#served.set(goal, at + 1);
      return this.#scripts.get(goal)?.[at] ?? says("Done.");
    };
    const minds = this;
    return {
      async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
        const goal = /^Goal: (.*)$/m.exec(request.system)?.[1] ?? "";
        minds.requests.push({ goal, request });
        const turn = turnFor(goal);
        reportUsage(
          {
            role: "assistant",
            provider: "openrouter",
            model: "test/model",
            units: { inputTokens: 900, outputTokens: 10 },
            costUsd: minds.cost ?? undefined,
          },
          (record) => {
            minds.records.push(record);
            options.tap?.(record);
          },
        );
        if (turn instanceof Error) throw turn;
        if (typeof turn === "function") yield* turn(request);
        else yield* turn;
      },
    };
  };
}

const ORIGIN: TaskChat = { id: "chat-1", persona: "milky-green", call: "call-1" };
const ELSEWHERE: TaskChat = { id: "chat-2", persona: "milky-green", call: "call-9" };

let work = "";
let clock = 0;
let settings: AssistantSettings;
let problem: string | null = null;
let reports: TaskSnapshot[] = [];
let reportError: Error | null = null;
let added: string[] = [];
let minds: Minds;
let logs: CapturedLogs;
const managers: TaskManager[] = [];
const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;

beforeAll(() => {
  // web_fetch looks fetch up at each call: a call that gets this far fails without leaving here.
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`unexpected network call in a test: ${String(input)}`);
  }) as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "eidolon-tasks-"));
  clock = 1_700_000_000_000;
  settings = { enabled: true, folders: [], spendPauseUsd: 1, contextTokens: 128_000 };
  problem = null;
  reports = [];
  reportError = null;
  added = [];
  minds = new Minds();
  logs = captureLogs();
  // What the assistant role names; the tasks' minds are scripted.
  for (const [name, value] of [
    ["ASSISTANT_PROVIDER", "openrouter"],
    ["ASSISTANT_MODEL", "test/model"],
  ] as const) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
});

afterEach(async () => {
  for (const tasks of managers.splice(0)) await tasks.stop();
  logs.restore();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  rmSync(work, { recursive: true, force: true });
  rmSync(tasksDir(), { recursive: true, force: true });
  rmSync(join(dataHome(), "locks"), { recursive: true, force: true });
});

function manager(overrides: Partial<TaskManagerOptions> = {}): TaskManager {
  const made = new TaskManager({
    dataHome: dataHome(),
    settings: () => settings,
    addFolder: (folder) => {
      added.push(folder);
      settings = { ...settings, folders: [...settings.folders, folder] };
    },
    problem: () => problem,
    createMind: minds.createMind,
    now: () => clock,
    report: async (snapshot) => {
      reports.push(snapshot);
      if (reportError !== null) throw reportError;
    },
    ...overrides,
  });
  managers.push(made);
  return made;
}

async function booted(): Promise<TaskManager> {
  const tasks = manager();
  await tasks.boot();
  return tasks;
}

/** Polls `check` until it holds, failing after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

/** The task's snapshot once its status is one of `statuses`. */
async function reach(
  tasks: TaskManager,
  id: string,
  ...statuses: TaskStatus[]
): Promise<TaskSnapshot> {
  let snapshot = await tasks.get(id);
  await until(async () => {
    snapshot = await tasks.get(id);
    return statuses.includes(snapshot.status);
  });
  return snapshot;
}

function onDisk(id: string): Promise<TaskSnapshot | null> {
  return readSnapshot(join(tasksDir(), id));
}

function transcript(id: string): TaskEntry[] {
  const path = join(tasksDir(), id, "transcript.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as TaskEntry);
}

function types(id: string): string[] {
  return transcript(id).map((entry) => entry.type);
}

/** Each user message a request sent. */
function userLines(request: MindRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((message) => {
    const { role, content } = message as Record<string, unknown>;
    return role === "user" ? [String(content)] : [];
  });
}

/** Each tool message a request sent, as [call id, content]. */
function toolMessages(request: MindRequest | undefined): [string, string][] {
  return (request?.messages ?? []).flatMap((message) => {
    const { role, tool_call_id: id, content } = message as Record<string, unknown>;
    return role === "tool" ? [[String(id), String(content)]] : [];
  });
}

async function refused(work: Promise<unknown>): Promise<TaskRefused> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TaskRefused) return error;
    throw error;
  }
  throw new Error("expected the manager to refuse");
}

/** A task as a manager or laplace-task left it on disk, its transcript holding `entries`. */
async function seed(
  changes: Partial<TaskSnapshot>,
  entries: readonly TaskEntryDraft[] = [],
): Promise<TaskSnapshot> {
  const id = newTaskId();
  const dir = join(tasksDir(), id);
  const brief = {
    goal: "Seeded",
    deliverable: "Seeded",
    folder: join(work, "seeded"),
    check: "It is there",
  };
  const store = openTaskStore(dir);
  await store.append({ type: "brief", brief });
  for (const entry of entries) await store.append(entry);
  const snapshot = {
    v: 1,
    id,
    createdAt: clock,
    status: "paused",
    chat: ORIGIN,
    brief,
    model: { account: "openrouter", model: "test/model" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
    ...changes,
  } as TaskSnapshot;
  await writeSnapshot(dir, snapshot);
  return snapshot;
}

describe("a task she starts", () => {
  test("in a folder of assistant.folders runs at once, billed as the task's own, and is reported", async () => {
    settings = { ...settings, folders: [work] };
    const folder = join(work, "site");
    minds.cost = 0.25;
    minds.script("Write hi", [
      calls([call("c1", "write", { path: "hi.txt", content: "hi\n" })], "Writing."),
      says("Wrote hi.txt."),
    ]);
    const tasks = await booted();

    const started = await tasks.start({ goal: "Write hi", folder }, ORIGIN);
    expect(started).toEqual({
      v: 1,
      id: expect.any(String),
      createdAt: clock,
      status: "running",
      chat: ORIGIN,
      brief: {
        goal: "Write hi",
        deliverable: "Write hi",
        folder,
        check: "Check the deliverable against the goal",
      },
      model: { account: "openrouter", model: "test/model" },
      grants: [],
      spendPauseUsd: 1,
      spentUsd: 0,
      files: { read: [], written: [] },
      web: { mode: "ask", hosts: [], denied: [] },
    });

    clock += 5000;
    const ended = await reach(tasks, started.id, "succeeded");
    const file = realpathSync(join(folder, "hi.txt"));
    expect(readFileSync(file, "utf8")).toBe("hi\n");
    expect(ended).toMatchObject({
      status: "succeeded",
      outcome: { status: "succeeded", report: "Wrote hi.txt." },
      endedAt: clock,
      spentUsd: 0.5,
      files: { read: [], written: [file] },
    });
    expect(types(started.id)).toEqual([
      "brief",
      "assistant",
      "tool-start",
      "tool-result",
      "assistant",
      "end",
    ]);
    expect(minds.made).toEqual([{ role: "assistant", account: "openrouter", model: "test/model" }]);
    expect(minds.records.map(({ source, session }) => ({ source, session }))).toEqual([
      { source: "task", session: started.id },
      { source: "task", session: started.id },
    ]);
    // Tools for this task alone: web_fetch, which asks for each site, is among them.
    expect(minds.for("Write hi")[0]?.tools.map((tool) => tool.name)).toContain("web_fetch");

    await until(async () => (await onDisk(started.id))?.reported === true);
    expect(await onDisk(started.id)).toEqual({ ...ended, reported: true });
    expect(reports.map(({ id, status }) => [id, status])).toEqual([[started.id, "succeeded"]]);
    expect(tasks.running()).toBe(0);
  });

  test("outside assistant.folders waits for the owner's OK, with nothing made or run", async () => {
    const tasks = await booted();
    const folder = join(work, "outside");
    const started = await tasks.start(
      { goal: " Sort my photos ", folder: `${folder}/`, deliverable: "  ", check: "Each is dated" },
      ORIGIN,
    );
    expect(started).toMatchObject({
      status: "awaiting-approval",
      pending: { kind: "start" },
      brief: {
        goal: "Sort my photos",
        deliverable: "Sort my photos",
        folder,
        check: "Each is dated",
      },
    });
    expect(existsSync(folder)).toBe(false);
    expect(minds.made).toEqual([]);
    expect(types(started.id)).toEqual(["brief"]);
    expect(await onDisk(started.id)).toEqual(started);
    expect(tasks.running()).toBe(0);
  });

  test("is refused while Assistant Mode is off or not ready, and in a folder no task may have", async () => {
    const tasks = await booted();
    const brief = { goal: "Anything", folder: join(work, "x") };

    settings = { ...settings, enabled: false };
    expect(tasks.ready()).toBe(false);
    const off = await refused(tasks.start(brief, ORIGIN));
    expect([off.status, off.code]).toEqual([409, "assistant-off"]);

    settings = { ...settings, enabled: true };
    problem = "No provider fills ASSISTANT_PROVIDER";
    expect(tasks.ready()).toBe(false);
    const notReady = await refused(tasks.start(brief, ORIGIN));
    expect([notReady.status, notReady.code, notReady.message]).toEqual([
      409,
      "assistant-not-ready",
      "No provider fills ASSISTANT_PROVIDER",
    ]);

    problem = null;
    expect(tasks.ready()).toBe(true);
    // GrantRefused's reason, for her to relay.
    const home = await refused(tasks.start({ goal: "Tidy", folder: "~" }, ORIGIN));
    expect([home.status, home.code, home.message]).toEqual([
      400,
      "invalid-path",
      `No task may be granted ${homedir()}: it is or holds the home folder`,
    ]);
    const data = await refused(
      tasks.start({ goal: "Tidy", folder: join(dataHome(), "x") }, ORIGIN),
    );
    expect(data.message).toStartWith("No task may write ");
    const relative = await refused(tasks.start({ goal: "Tidy", folder: "projects/x" }, ORIGIN));
    expect([relative.status, relative.code]).toEqual([400, "invalid-path"]);
    const empty = await refused(tasks.start({ goal: "  ", folder: work }, ORIGIN));
    expect([empty.status, empty.code]).toEqual([400, "bad-request"]);

    expect(await tasks.list()).toEqual([]);
    expect(existsSync(tasksDir()) ? readdirSync(tasksDir()) : []).toEqual([]);
  });

  test("in a file, or under one, is refused before anything is asked", async () => {
    mkdirSync(join(work, "site"));
    writeFileSync(join(work, "precious.rc"), "original\n");
    writeFileSync(join(work, "site", "notes.txt"), "notes\n");
    // In assistant.folders it would run at once; anywhere else Always would add the file to them.
    settings = { ...settings, folders: [join(work, "site")] };
    const tasks = await booted();
    for (const folder of [join(work, "precious.rc"), join(work, "site", "notes.txt")]) {
      const file = await refused(tasks.start({ goal: "In a file", folder }, ORIGIN));
      expect([file.status, file.code, file.message]).toEqual([
        400,
        "invalid-path",
        `${folder} can't be a task's folder: it is a file`,
      ]);
    }
    const through = join(work, "precious.rc", "sub");
    const under = await refused(tasks.start({ goal: "In a file", folder: through }, ORIGIN));
    expect([under.status, under.code]).toEqual([400, "invalid-path"]);
    expect(under.message).toStartWith(`${through} can't be a task's folder: ENOTDIR`);

    expect(await tasks.list()).toEqual([]);
    expect(minds.made).toEqual([]);
    expect(readFileSync(join(work, "precious.rc"), "utf8")).toBe("original\n");
  });

  test("in a folder another live task works in, or one holding it, is refused", async () => {
    const tasks = await booted();
    const first = await tasks.start({ goal: "Build the site", folder: join(work, "a") }, ORIGIN);

    for (const folder of [join(work, "a"), join(work, "a", "b"), work]) {
      const busy = await refused(tasks.start({ goal: "Another", folder }, ELSEWHERE));
      expect([busy.status, busy.code, busy.message]).toEqual([
        409,
        "conflict",
        `A task is already working in ${join(work, "a")}: Build the site.`,
      ]);
    }
    const beside = await tasks.start({ goal: "Another", folder: join(work, "c") }, ORIGIN);
    expect(beside.status).toBe("awaiting-approval");

    // An ended task works nowhere.
    await tasks.cancel(first.id);
    const after = await tasks.start({ goal: "Again", folder: join(work, "a", "b") }, ORIGIN);
    expect(after.status).toBe("awaiting-approval");
  });

  test("two starts at once in one folder: the second is refused", async () => {
    const tasks = await booted();
    const outcomes = await Promise.allSettled([
      tasks.start({ goal: "One", folder: join(work, "same") }, ORIGIN),
      tasks.start({ goal: "Two", folder: join(work, "same") }, ORIGIN),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
  });
});

describe("its run", () => {
  test("pauses at each multiple of its spend pause, and Continue goes on, or with a new pause", async () => {
    settings = { ...settings, folders: [work] };
    minds.cost = 0.6;
    const ls = call("l1", "ls", { path: "." });
    minds.script("Spend", [calls([ls]), calls([{ ...ls, id: "l2" }]), says("Spent it.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Spend", folder: join(work, "spend") }, ORIGIN);

    const paused = await reach(tasks, id, "paused");
    expect(paused).toMatchObject({
      status: "paused",
      pause: { reason: "spend", detail: "Spent $1.20; it pauses at every $1.00." },
    });
    expect(paused).not.toHaveProperty("pending");
    expect(paused.spentUsd).toBeCloseTo(1.2);
    await until(async () => (await onDisk(id))?.status === "paused");

    const continued = await tasks.continue(id, { spendPauseUsd: 5 });
    expect(continued).toMatchObject({ status: "running", spendPauseUsd: 5 });
    expect(continued).not.toHaveProperty("pause");
    const ended = await reach(tasks, id, "succeeded");
    expect(ended.spentUsd).toBeCloseTo(1.8);
    expect(ended.spendPauseUsd).toBe(5);
  });

  test("pauses when the same calls repeat three turns running", async () => {
    settings = { ...settings, folders: [work] };
    const ls = call("l1", "ls", { path: "." });
    minds.script("Loop", [calls([ls]), calls([ls]), calls([ls]), says("Out of the loop.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Loop", folder: join(work, "loop") }, ORIGIN);
    const paused = await reach(tasks, id, "paused");
    expect(paused.pause?.reason).toBe("stall");
    await tasks.continue(id);
    expect((await reach(tasks, id, "succeeded")).outcome).toEqual({
      status: "succeeded",
      report: "Out of the loop.",
    });
  });

  test("pauses after a request it can't price, and Continue turns its spend pauses off", async () => {
    settings = { ...settings, folders: [work] };
    minds.cost = null;
    minds.script("Unpriced", [calls([call("l1", "ls", { path: "." })]), says("Done anyway.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Unpriced", folder: join(work, "u") }, ORIGIN);
    const paused = await reach(tasks, id, "paused");
    expect(paused.pause?.reason).toBe("unpriced");
    expect(paused.pause?.detail).toEndWith(
      "so its spend can't count toward the pause at every $1.00.",
    );

    // Spend pauses can't count what has no price: a pause in the body doesn't bring them back.
    expect(await tasks.continue(id, { spendPauseUsd: 2 })).toMatchObject({
      status: "running",
      spendPauseUsd: 0,
    });
    await reach(tasks, id, "succeeded");
    expect((await onDisk(id))?.spendPauseUsd).toBe(0);
  });

  test("fails on a request that can't succeed, storing how it ended", async () => {
    settings = { ...settings, folders: [work] };
    minds.script("Fail", [new ProviderHttpError("OpenRouter", 400, "No such model")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Fail", folder: join(work, "f") }, ORIGIN);
    const failed = await reach(tasks, id, "failed");
    expect(failed.outcome).toEqual({
      status: "failed",
      error: "OpenRouter answered 400: No such model",
    });
    expect(failed.endedAt).toBe(clock);
    expect(types(id)).toEqual(["brief", "end"]);
    await until(() => reports.length === 1);
    expect(reports[0]?.status).toBe("failed");
  });

  test("keeps task.json in step: within a second while it streams, at once at a status change", async () => {
    settings = { ...settings, folders: [work] };
    const open = deferred();
    minds.script("Steps", [
      calls([
        call("c1", "write", { path: "a.txt", content: "a" }),
        call("t1", "todo", { items: [{ text: "Write a.txt", status: "done" }] }),
      ]),
      held(open.promise, says("Wrote a.txt.")),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Steps", folder: join(work, "steps") }, ORIGIN);
    const file = realpathSync(work);
    await until(async () => (await onDisk(id))?.files.written.length === 1, 3000);
    expect(await onDisk(id)).toMatchObject({
      status: "running",
      files: { written: [join(file, "steps", "a.txt")] },
      todo: [{ text: "Write a.txt", status: "done" }],
    });
    open.resolve();
    await reach(tasks, id, "succeeded");
    await until(async () => (await onDisk(id))?.status === "succeeded", 500);
  });
});

describe("approvals", () => {
  test("Allow Once at a start makes the folder and runs the task; assistant.folders stay", async () => {
    const tasks = await booted();
    const folder = join(work, "new-site");
    const { id } = await tasks.start({ goal: "Make a page", folder }, ORIGIN);
    const approved = await tasks.approve(id, { answer: "once" });
    expect(approved.status).toBe("running");
    expect(approved).not.toHaveProperty("pending");
    await reach(tasks, id, "succeeded");
    expect(existsSync(folder)).toBe(true);
    expect(added).toEqual([]);
    expect(settings.folders).toEqual([]);
  });

  test("Always Allow at a start adds the folder to assistant.folders first", async () => {
    const tasks = await booted();
    const folder = join(work, "always");
    const { id } = await tasks.start({ goal: "Always", folder }, ORIGIN);
    await tasks.approve(id, { answer: "always" });
    expect(added).toEqual([folder]);
    await reach(tasks, id, "succeeded");
    // The next task there runs at once.
    const next = await tasks.start({ goal: "Next", folder: join(folder, "sub") }, ORIGIN);
    expect(next.status).toBe("running");
  });

  test("Deny at a start ends it cancelled and denied, even with Assistant Mode off", async () => {
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "No", folder: join(work, "no") }, ORIGIN);
    settings = { ...settings, enabled: false };
    const denied = await tasks.approve(id, { answer: "deny" });
    expect(denied).toMatchObject({
      status: "cancelled",
      denied: true,
      outcome: { status: "cancelled" },
      endedAt: clock,
    });
    expect(denied).not.toHaveProperty("pending");
    expect(types(id)).toEqual(["brief", "end"]);
    expect(minds.made).toEqual([]);
    await until(async () => (await onDisk(id))?.reported === true);
    expect(reports.map(({ status, denied }) => [status, denied])).toEqual([["cancelled", true]]);
  });

  test("a start's approval may switch the model and the web access", async () => {
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Switch", folder: join(work, "sw") }, ORIGIN);
    const approved = await tasks.approve(id, {
      answer: "once",
      model: { account: " Anthropic ", model: " claude-test " },
      web: "off",
    });
    expect(approved).toMatchObject({
      model: { account: "anthropic", model: "claude-test" },
      web: { mode: "off", hosts: [], denied: [] },
    });
    await reach(tasks, id, "succeeded");
    expect(minds.made).toEqual([{ role: "assistant", account: "anthropic", model: "claude-test" }]);
    expect(minds.for("Switch")[0]?.tools.map((tool) => tool.name)).not.toContain("web_fetch");
  });

  test("a model createMind refuses is a 400 that changes nothing", async () => {
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Bad model", folder: join(work, "bm") }, ORIGIN);
    const before = await tasks.get(id);

    const unknown = await refused(
      tasks.approve(id, { answer: "once", model: { account: "nope", model: "x" } }),
    );
    expect([unknown.status, unknown.code]).toEqual([400, "unknown-account"]);

    minds.refuse = new ProviderConfigError("Anthropic needs a key: set ANTHROPIC_API_KEY");
    const keyless = await refused(
      tasks.approve(id, { answer: "always", model: { account: "anthropic", model: "x" } }),
    );
    expect([keyless.status, keyless.code, keyless.message]).toEqual([
      400,
      "bad-request",
      "Anthropic needs a key: set ANTHROPIC_API_KEY",
    ]);
    expect(await tasks.get(id)).toEqual(before);
    expect(added).toEqual([]);
    expect(existsSync(join(work, "bm"))).toBe(false);
  });

  test("a path's question names the folder an Allow grants; Allow Once grants it, and the run goes on", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "notes"));
    writeFileSync(join(work, "notes", "notes.txt"), "remember the milk\n");
    const notes = realpathSync(join(work, "notes", "notes.txt"));
    const read = call("r1", "read", { path: join(work, "notes", "notes.txt") });
    minds.script("Read notes", [calls([read]), calls([{ ...read, id: "r2" }]), says("Read.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Read notes", folder: join(work, "site") }, ORIGIN);

    const paused = await reach(tasks, id, "paused");
    expect(paused.pending).toEqual({
      kind: "path",
      path: notes,
      access: "read",
      folder: realpathSync(join(work, "notes")),
    });
    expect((await onDisk(id))?.pending).toEqual(paused.pending);

    const approved = await tasks.approve(id, { answer: "once" });
    expect(approved).toMatchObject({
      status: "running",
      grants: [{ path: realpathSync(join(work, "notes")), access: "read" }],
    });
    expect(approved).not.toHaveProperty("pending");
    await reach(tasks, id, "succeeded");
    const after = minds.for("Read notes")[1];
    expect(userLines(after).at(-1)).toBe(
      `The owner allowed read access to ${realpathSync(join(work, "notes"))}. Try again.`,
    );
    expect(toolMessages(minds.for("Read notes")[2]).at(-1)?.[1]).toContain("remember the milk");
    expect(added).toEqual([]);
  });

  test("an Allow grants what its question named at the pause, whatever the path is by the answer", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "docs", "tax"), { recursive: true });
    const docs = realpathSync(join(work, "docs"));
    const tax = join(docs, "tax");
    minds.script("Taxes", [calls([call("l1", "ls", { path: tax })]), says("Done.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Taxes", folder: join(work, "site") }, ORIGIN);
    const { pending } = await reach(tasks, id, "paused");
    // A folder: an Allow grants it, not its parent.
    expect(pending).toEqual({ kind: "path", path: tax, access: "read", folder: tax });

    // A file by the answer, which a stat then would take for one in docs, granting all of docs.
    rmSync(tax, { recursive: true });
    writeFileSync(tax, "2025\n");
    expect((await tasks.approve(id, { answer: "once", pending })).grants).toEqual([
      { path: tax, access: "read" },
    ]);
    await reach(tasks, id, "succeeded");
  });

  test("Always Allow on a path adds its folder to assistant.folders too; Deny grants nothing", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "notes"));
    writeFileSync(join(work, "notes", "a.txt"), "a\n");
    const notesDir = realpathSync(join(work, "notes"));
    const read = call("r1", "read", { path: join(work, "notes", "a.txt") });
    const write = call("w1", "write", { path: join(work, "notes", "b.txt"), content: "b\n" });
    minds.script("Always", [calls([write]), calls([{ ...write, id: "w2" }]), says("Wrote.")]);
    minds.script("Denied", [calls([{ ...read, id: "r9" }]), says("Couldn't.")]);
    const tasks = await booted();

    const always = await tasks.start({ goal: "Always", folder: join(work, "site") }, ORIGIN);
    expect((await reach(tasks, always.id, "paused")).pending).toEqual({
      kind: "path",
      path: join(notesDir, "b.txt"),
      access: "write",
      folder: notesDir,
    });
    await tasks.approve(always.id, { answer: "always" });
    expect(added).toEqual([notesDir]);
    expect((await reach(tasks, always.id, "succeeded")).grants).toEqual([
      { path: notesDir, access: "read-write" },
    ]);
    expect(readFileSync(join(notesDir, "b.txt"), "utf8")).toBe("b\n");

    settings = { ...settings, folders: [join(work, "site")] };
    const denied = await tasks.start({ goal: "Denied", folder: join(work, "site") }, ORIGIN);
    await reach(tasks, denied.id, "paused");
    expect((await tasks.approve(denied.id, { answer: "deny" })).grants).toEqual([]);
    await reach(tasks, denied.id, "succeeded");
    expect(userLines(minds.for("Denied")[1]).at(-1)).toBe(
      `The owner refused access to ${join(notesDir, "a.txt")}.`,
    );
    expect(added).toEqual([notesDir]);
  });

  test("a file right in home is asked about and granted alone; home itself is refused unasked", async () => {
    settings = { ...settings, folders: [work] };
    const home = realpathSync(homedir());
    // Never made: the worker only asks to read it.
    const name = `eidolon-test-${newTaskId()}.txt`;
    minds.script("Home", [
      calls([call("r1", "read", { path: join(homedir(), name) })]),
      calls([call("l1", "ls", { path: homedir() })]),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Home", folder: join(work, "home") }, ORIGIN);

    // No folder: home can't be granted, so an Allow grants the file alone.
    const { pending } = await reach(tasks, id, "paused");
    expect(pending).toEqual({ kind: "path", path: join(home, name), access: "read" });
    expect((await tasks.approve(id, { answer: "once", pending })).grants).toEqual([
      { path: join(home, name), access: "read" },
    ]);
    // An Allow could grant nothing for home, so the worker hears so at once.
    expect((await reach(tasks, id, "paused", "succeeded")).status).toBe("succeeded");
    expect(types(id).filter((type) => type === "pause")).toHaveLength(1);
    expect(toolMessages(minds.for("Home")[2]).at(-1)).toEqual([
      "l1",
      `No task may read ${home}, whatever access it is given.`,
    ]);
    expect(added).toEqual([]);
  });

  test("Always on a read lets this task read alone: assistant.folders, which every task may write, stay", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "notes"));
    writeFileSync(join(work, "notes", "a.txt"), "a\n");
    const notes = realpathSync(join(work, "notes"));
    const file = join(notes, "a.txt");
    minds.script("Read, then write", [
      calls([call("r1", "read", { path: file })]),
      calls([call("w1", "write", { path: file, content: "overwritten\n" })]),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start(
      { goal: "Read, then write", folder: join(work, "site") },
      ORIGIN,
    );
    expect((await reach(tasks, id, "paused")).pending).toEqual({
      kind: "path",
      path: file,
      access: "read",
      folder: notes,
    });

    expect((await tasks.approve(id, { answer: "always" })).grants).toEqual([
      { path: notes, access: "read" },
    ]);
    expect(added).toEqual([]);
    // Writing there is a question of its own.
    await until(async () => (await tasks.get(id)).pending?.kind === "path");
    expect((await tasks.get(id)).pending).toEqual({
      kind: "path",
      path: file,
      access: "write",
      folder: notes,
    });
    expect(readFileSync(file, "utf8")).toBe("a\n");
    await tasks.approve(id, { answer: "deny" });
    await reach(tasks, id, "succeeded");
    // Nor may a task start there without the owner's OK.
    const later = await tasks.start({ goal: "Later", folder: join(notes, "sub") }, ORIGIN);
    expect(later.status).toBe("awaiting-approval");
  });

  test("an answer names its question, and one for a question the task no longer asks is refused", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "a"));
    writeFileSync(join(work, "a", "x.txt"), "x\n");
    mkdirSync(join(work, "secret"));
    const x = realpathSync(join(work, "a", "x.txt"));
    const y = join(realpathSync(join(work, "secret")), "y.txt");
    minds.script("Two questions", [
      calls([call("r1", "read", { path: x })]),
      calls([call("w1", "write", { path: y, content: "y\n" })]),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Two questions", folder: join(work, "site") }, ORIGIN);
    const read = (await reach(tasks, id, "paused")).pending;
    expect(read).toEqual({
      kind: "path",
      path: x,
      access: "read",
      folder: realpathSync(join(work, "a")),
    });
    await tasks.approve(id, { answer: "once", pending: read });
    await until(async () => (await tasks.get(id)).pending?.kind === "path");
    const write = (await tasks.get(id)).pending;
    expect(write).toEqual({
      kind: "path",
      path: y,
      access: "write",
      folder: realpathSync(join(work, "secret")),
    });

    // A second tab still showing the read question answers it.
    const stale = await refused(tasks.approve(id, { answer: "always", pending: read }));
    expect([stale.status, stale.code]).toEqual([409, "nothing-pending"]);
    for (const other of [{ kind: "start" }, { kind: "fetch", host: "example.com" }] as const) {
      expect((await refused(tasks.approve(id, { answer: "once", pending: other }))).code).toBe(
        "nothing-pending",
      );
    }
    expect((await tasks.get(id)).grants).toEqual([
      { path: realpathSync(join(work, "a")), access: "read" },
    ]);
    expect(added).toEqual([]);

    await tasks.approve(id, { answer: "deny", pending: write });
    await reach(tasks, id, "succeeded");
    expect(existsSync(y)).toBe(false);
  });

  test("a path asked again with another folder is another question: an answer to the first is refused", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "a"));
    const a = realpathSync(join(work, "a"));
    const x = join(a, "x");
    minds.script("Asked twice", [
      calls([call("l1", "ls", { path: x })]),
      calls([call("l2", "ls", { path: x })]),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Asked twice", folder: join(work, "site") }, ORIGIN);
    // Not there yet, so an Allow grants its folder.
    const first = (await reach(tasks, id, "paused")).pending;
    expect(first).toEqual({ kind: "path", path: x, access: "read", folder: a });
    mkdirSync(x);
    await tasks.approve(id, { answer: "deny", pending: first });
    await until(async () => (await tasks.get(id)).status === "paused");
    const second = (await tasks.get(id)).pending;
    expect(second).toEqual({ kind: "path", path: x, access: "read", folder: x });

    // A tab still showing the first question named all of a.
    const stale = await refused(tasks.approve(id, { answer: "once", pending: first }));
    expect([stale.status, stale.code]).toEqual([409, "nothing-pending"]);
    expect((await tasks.approve(id, { answer: "once", pending: second })).grants).toEqual([
      { path: x, access: "read" },
    ]);
    await reach(tasks, id, "succeeded");
  });

  test("Always on a file right in home grants it to this task alone: no file joins assistant.folders", async () => {
    settings = { ...settings, folders: [work] };
    const home = realpathSync(homedir());
    // Never made: the worker gives up once it may write it.
    const name = `eidolon-test-${newTaskId()}.rc`;
    minds.script("Home rc", [
      calls([call("w1", "write", { path: join(homedir(), name), content: "x\n" })]),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Home rc", folder: join(work, "rc") }, ORIGIN);
    expect((await reach(tasks, id, "paused")).pending).toEqual({
      kind: "path",
      path: join(home, name),
      access: "write",
    });
    expect((await tasks.approve(id, { answer: "always" })).grants).toEqual([
      { path: join(home, name), access: "read-write" },
    ]);
    expect(added).toEqual([]);
    await reach(tasks, id, "succeeded");
    expect(existsSync(join(home, name))).toBe(false);
  });

  test("a path through a file names no folder: Always grants that path alone, and no file joins assistant.folders", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "outside"));
    writeFileSync(join(work, "outside", "precious.rc"), "original\n");
    const file = realpathSync(join(work, "outside", "precious.rc"));
    minds.script("Through a file", [
      calls([call("w1", "write", { path: join(file, "x"), content: "x\n" })]),
      calls([call("w2", "write", { path: join(file, "a", "b"), content: "b\n" })]),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start(
      { goal: "Through a file", folder: join(work, "site") },
      ORIGIN,
    );
    // Named as a folder, the file would join assistant.folders, for every task to write.
    const first = (await reach(tasks, id, "paused")).pending;
    expect(first).toEqual({ kind: "path", path: join(file, "x"), access: "write" });
    expect((await tasks.approve(id, { answer: "always", pending: first })).grants).toEqual([
      { path: join(file, "x"), access: "read-write" },
    ]);
    await until(async () => (await tasks.get(id)).pending?.kind === "path");
    expect((await tasks.get(id)).pending).toEqual({
      kind: "path",
      path: join(file, "a", "b"),
      access: "write",
    });
    await tasks.approve(id, { answer: "deny" });
    await reach(tasks, id, "succeeded");
    expect(added).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("original\n");
  });

  test("a folder not made yet is never named: an Allow grants the path alone, so the task can't write that folder as a file", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "dotconfig", "git"), { recursive: true });
    const git = realpathSync(join(work, "dotconfig", "git"));
    // git's own config file, not there yet.
    const config = join(git, "config");
    minds.script("Git config", [
      calls([call("w1", "write", { path: join(config, "notes.md"), content: "x\n" })]),
      calls([call("w2", "write", { path: config, content: "[core]\n\tpager = touch pwned\n" })]),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Git config", folder: join(work, "site") }, ORIGIN);
    // A grant holds its own path: one of config would let the task write config as a file.
    const first = (await reach(tasks, id, "paused")).pending;
    expect(first).toEqual({ kind: "path", path: join(config, "notes.md"), access: "write" });
    expect((await tasks.approve(id, { answer: "always", pending: first })).grants).toEqual([
      { path: join(config, "notes.md"), access: "read-write" },
    ]);
    expect(added).toEqual([]);
    // Writing config itself is a question of its own, naming the folder that holds it.
    await until(async () => (await tasks.get(id)).pending?.kind === "path");
    expect((await tasks.get(id)).pending).toEqual({
      kind: "path",
      path: config,
      access: "write",
      folder: git,
    });
    await tasks.approve(id, { answer: "deny" });
    await reach(tasks, id, "succeeded");
    expect(existsSync(config)).toBe(false);
  });

  test("a settings write that fails leaves the task as it was, its lock free", async () => {
    let fail = true;
    const tasks = manager({
      addFolder: (folder) => {
        if (fail) throw new Error("settings.yaml isn't YAML");
        added.push(folder);
      },
    });
    await tasks.boot();
    const { id } = await tasks.start({ goal: "Write", folder: join(work, "x") }, ORIGIN);
    const before = await tasks.get(id);
    await expect(tasks.approve(id, { answer: "always" })).rejects.toThrow(
      "settings.yaml isn't YAML",
    );
    expect(await tasks.get(id)).toEqual(before);
    fail = false;
    expect((await tasks.approve(id, { answer: "always" })).status).toBe("running");
    await reach(tasks, id, "succeeded");
  });

  test("a path no task may have is never asked about: the error is the answer", async () => {
    settings = { ...settings, folders: [work] };
    minds.script("Peek", [
      calls([call("r1", "read", { path: join(dataHome(), "credentials.json") })]),
      says("Not allowed."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Peek", folder: join(work, "peek") }, ORIGIN);
    await reach(tasks, id, "succeeded");
    expect(types(id)).not.toContain("pause");
    expect(toolMessages(minds.for("Peek")[1])[0]?.[1]).toStartWith("No task may read");
  });

  test("a site pauses before its call starts; Allow Once lets that site through", async () => {
    settings = { ...settings, folders: [work] };
    const fetchIt = call("f1", "web_fetch", { url: "https://203.0.113.7/page" });
    minds.script("Fetch", [calls([fetchIt]), says("Fetched.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Fetch", folder: join(work, "fetch") }, ORIGIN);

    const paused = await reach(tasks, id, "paused");
    expect(paused.pending).toEqual({ kind: "fetch", host: "203.0.113.7" });
    expect(types(id)).toEqual(["brief", "assistant", "pause"]);

    expect((await tasks.approve(id, { answer: "once" })).web).toEqual({
      mode: "ask",
      hosts: ["203.0.113.7"],
      denied: [],
    });
    await reach(tasks, id, "succeeded");
    // Gated again on resume, and run: this test's fetch refuses every request.
    expect(types(id)).toEqual([
      "brief",
      "assistant",
      "pause",
      "resume",
      "tool-start",
      "tool-result",
      "assistant",
      "end",
    ]);
  });

  test("Allow Any Site lets every site through; Deny refuses that site in the call's result", async () => {
    settings = { ...settings, folders: [work] };
    minds.script("Any", [
      calls([call("f1", "web_fetch", { url: "https://203.0.113.7/" })]),
      says("Fetched."),
    ]);
    minds.script("Deny site", [
      calls([call("f2", "web_fetch", { url: "https://203.0.113.9/" })]),
      says("Refused."),
    ]);
    const tasks = await booted();

    const any = await tasks.start({ goal: "Any", folder: join(work, "any") }, ORIGIN);
    await reach(tasks, any.id, "paused");
    expect((await tasks.approve(any.id, { answer: "always" })).web?.mode).toBe("any");
    await reach(tasks, any.id, "succeeded");

    const deny = await tasks.start({ goal: "Deny site", folder: join(work, "deny") }, ORIGIN);
    await reach(tasks, deny.id, "paused");
    expect((await tasks.approve(deny.id, { answer: "deny" })).web).toEqual({
      mode: "ask",
      hosts: [],
      denied: ["203.0.113.9"],
    });
    await reach(tasks, deny.id, "succeeded");
    expect(toolMessages(minds.for("Deny site")[1])).toEqual([
      ["f2", "The owner refused fetching from 203.0.113.9."],
    ]);
    expect(types(deny.id)).not.toContain("tool-start");
  });

  test("answers that don't fit the task are refused", async () => {
    settings = { ...settings, folders: [join(work, "in")] };
    const open = deferred();
    minds.script("Busy", [held(open.promise)]);
    const tasks = await booted();
    const running = await tasks.start({ goal: "Busy", folder: join(work, "in") }, ORIGIN);
    const waiting = await tasks.start({ goal: "Waiting", folder: join(work, "out") }, ORIGIN);

    const nothing = await refused(tasks.approve(running.id, { answer: "once" }));
    expect([nothing.status, nothing.code]).toEqual([409, "nothing-pending"]);
    const notPaused = await refused(tasks.continue(running.id));
    expect([notPaused.status, notPaused.code]).toEqual([409, "not-paused"]);
    const pending = await refused(tasks.continue(waiting.id));
    expect([pending.status, pending.code]).toEqual([409, "pending"]);
    const bad = await refused(
      tasks.approve(waiting.id, { answer: "maybe" } as unknown as { answer: "once" }),
    );
    expect([bad.status, bad.code]).toEqual([400, "bad-request"]);
    const badPause = await refused(tasks.continue(waiting.id, { spendPauseUsd: -1 }));
    expect([badPause.status, badPause.code]).toEqual([400, "bad-request"]);

    settings = { ...settings, enabled: false };
    const off = await refused(tasks.approve(waiting.id, { answer: "once" }));
    expect([off.status, off.code]).toEqual([409, "assistant-off"]);
    settings = { ...settings, enabled: true };
    problem = "No key";
    const notReady = await refused(tasks.approve(waiting.id, { answer: "once" }));
    expect([notReady.status, notReady.code]).toEqual([409, "assistant-not-ready"]);
    expect((await tasks.get(waiting.id)).pending).toEqual({ kind: "start" });

    const unknown = await refused(tasks.approve(newTaskId(), { answer: "once" }));
    expect([unknown.status, unknown.code]).toEqual([404, "unknown-task"]);
    open.resolve();
  });
});

describe("a restart", () => {
  test("stopping interrupts a run, storing nothing more; the next start resumes it", async () => {
    settings = { ...settings, folders: [work] };
    const open = deferred();
    minds.script("Long", [
      calls([call("c1", "write", { path: "part1.txt", content: "1" })]),
      held(open.promise, says("Never heard.")),
      says("Finished."),
    ]);
    const first = await booted();
    const { id } = await first.start({ goal: "Long", folder: join(work, "long") }, ORIGIN);
    await until(() => minds.for("Long").length === 2);

    await first.stop();
    expect(minds.for("Long")[1]?.signal.aborted).toBe(true);
    expect((await onDisk(id))?.status).toBe("interrupted");
    const before = types(id);
    expect(before).toEqual(["brief", "assistant", "tool-start", "tool-result"]);
    open.resolve();
    await Bun.sleep(20);
    expect(types(id)).toEqual(before);

    const second = await booted();
    const resumed = await reach(second, id, "succeeded");
    expect(resumed.outcome).toEqual({ status: "succeeded", report: "Finished." });
    expect(types(id)).toEqual([...before, "resume", "assistant", "end"]);
    await until(() => reports.length === 1);
  });

  test("a task a crash left running is interrupted, and waits for Continue while not ready", async () => {
    const seeded = await seed({ status: "running" });
    problem = "No key";
    const tasks = await booted();
    expect((await tasks.get(seeded.id)).status).toBe("interrupted");
    expect((await onDisk(seeded.id))?.status).toBe("interrupted");
    expect(minds.made).toEqual([]);

    const notReady = await refused(tasks.continue(seeded.id));
    expect(notReady.code).toBe("assistant-not-ready");
    problem = null;
    expect((await tasks.continue(seeded.id)).status).toBe("running");
    await reach(tasks, seeded.id, "succeeded");
  });

  test("a task another holder's lock holds is neither resumed nor continued", async () => {
    const seeded = await seed({ status: "interrupted" });
    const running = await seed({ status: "running" });
    const release = acquireLock(`task:${seeded.id}`, "laplace-task");
    const releaseRunning = acquireLock(`task:${running.id}`, "laplace-task");
    try {
      const tasks = await booted();
      expect((await tasks.get(seeded.id)).status).toBe("interrupted");
      // laplace-task runs it: no crash left it.
      expect((await onDisk(running.id))?.status).toBe("running");

      const locked = await refused(tasks.continue(seeded.id));
      expect([locked.status, locked.code]).toEqual([409, "task-locked"]);
      expect(locked.message).toContain("laplace-task");
      const stop = await refused(tasks.cancel(running.id));
      expect(stop.code).toBe("task-locked");

      release();
      await tasks.continue(seeded.id);
      await reach(tasks, seeded.id, "succeeded");
    } finally {
      release();
      releaseRunning();
    }
  });

  test("the inbox stays in task.json while the task isn't running, and its run takes it", async () => {
    const seeded = await seed({
      status: "paused",
      pause: { reason: "spend", detail: "Spent $1.00; it pauses at every $1.00." },
      inbox: { steer: ["Use tabs."], followUp: [] },
    });
    const tasks = await booted();
    expect((await onDisk(seeded.id))?.inbox).toEqual({ steer: ["Use tabs."], followUp: [] });

    await tasks.continue(seeded.id);
    await reach(tasks, seeded.id, "succeeded");
    expect(userLines(minds.for("Seeded")[0]).at(-1)).toBe("Use tabs.");
    expect(types(seeded.id)).toEqual(["brief", "steer", "assistant", "end"]);
    expect(await onDisk(seeded.id)).not.toHaveProperty("inbox");
  });
});

describe("cancelling", () => {
  test("Stop cancels a running task, which stores its end; an ended task comes back as it is", async () => {
    settings = { ...settings, folders: [work] };
    minds.script("Stop me", [held(new Promise(() => {}))]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Stop me", folder: join(work, "s") }, ORIGIN);
    await until(() => minds.for("Stop me").length === 1);

    const cancelled = await tasks.cancel(id);
    expect(cancelled).toMatchObject({ status: "cancelled", outcome: { status: "cancelled" } });
    expect(minds.for("Stop me")[0]?.signal.aborted).toBe(true);
    expect(types(id)).toEqual(["brief", "end"]);
    await until(async () => (await onDisk(id))?.reported === true);

    const again = await tasks.cancel(id);
    expect(again).toEqual({ ...cancelled, reported: true });
    expect(types(id)).toEqual(["brief", "end"]);
    // A cancelled task never runs again.
    expect((await refused(tasks.continue(id))).code).toBe("not-paused");
    expect((await refused(tasks.approve(id, { answer: "once" }))).code).toBe("nothing-pending");
    await Bun.sleep(20);
    expect(reports.map(({ status }) => status)).toEqual(["cancelled"]);
  });

  test("Stop, a deleted chat or Assistant Mode off ends a task whose run was deciding to pause", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "notes"));
    writeFileSync(join(work, "notes", "a.txt"), "a\n");
    const read = call("r1", "read", { path: join(work, "notes", "a.txt") });
    const tasks = await booted();
    const ways: Record<string, (id: string) => Promise<unknown>> = {
      Stop: (id) => tasks.cancel(id),
      "a deleted chat": () => tasks.cancelChat(ORIGIN.id),
      "Assistant Mode off": async () => {
        settings = { ...settings, enabled: false };
        await tasks.modeChanged(false);
      },
    };
    const ended: Record<string, [TaskStatus, string | undefined]> = {};
    const ids: string[] = [];
    for (const [way, cancel] of Object.entries(ways)) {
      minds.script(way, [calls([read]), says("Never asked.")]);
      const { id } = await tasks.start({ goal: way, folder: join(work, "site", way) }, ORIGIN);
      ids.push(id);
      // The refused read's result is stored: the run is storing its pause now.
      const reader = (await tasks.events(id, 0)).getReader();
      let text = "";
      while (!text.includes('"type":"tool-result"')) {
        const { value, done } = await reader.read();
        if (done) throw new Error("ended early");
        text += new TextDecoder().decode(value);
      }
      await cancel(id);
      await reader.cancel();
      ended[way] = [(await tasks.get(id)).status, types(id).at(-1)];
    }
    expect(ended).toEqual({
      Stop: ["cancelled", "end"],
      "a deleted chat": ["cancelled", "end"],
      "Assistant Mode off": ["cancelled", "end"],
    });
    await until(() => ids.every((id) => reports.some((each) => each.id === id)));
    // Nothing is left working in their folders.
    settings = { ...settings, enabled: true };
    const after = await tasks.start({ goal: "After", folder: join(work, "site") }, ORIGIN);
    expect(after.status).toBe("running");
  });

  test("cancelChat stops every live task of that chat and no other", async () => {
    const tasks = await booted();
    const one = await tasks.start({ goal: "One", folder: join(work, "1") }, ORIGIN);
    const two = await tasks.start({ goal: "Two", folder: join(work, "2") }, ORIGIN);
    const other = await tasks.start({ goal: "Other", folder: join(work, "3") }, ELSEWHERE);

    await tasks.cancelChat(ORIGIN.id);
    expect((await tasks.get(one.id)).status).toBe("cancelled");
    expect((await tasks.get(two.id)).status).toBe("cancelled");
    expect(await tasks.get(other.id)).toEqual(other);
    expect(types(one.id)).toEqual(["brief", "end"]);
  });

  test("Stop ends a task whose transcript is damaged: task.json says it is over", async () => {
    const seeded = await seed({ status: "paused", pause: { reason: "stall", detail: "Stalled." } });
    const path = join(tasksDir(), seeded.id, "transcript.jsonl");
    writeFileSync(path, `not json\n${readFileSync(path, "utf8")}`);
    const tasks = await booted();
    expect((await tasks.cancel(seeded.id)).status).toBe("cancelled");
    expect((await onDisk(seeded.id))?.status).toBe("cancelled");
    const warned = `WARNING Task ${seeded.id}'s end wasn't stored`;
    expect(logs.lines().some((line) => line.startsWith(warned))).toBe(true);
  });

  test("turning Assistant Mode off cancels every live task", async () => {
    settings = { ...settings, folders: [join(work, "in")] };
    minds.script("A", [held(new Promise(() => {}))]);
    minds.script("B", [held(new Promise(() => {}))]);
    const tasks = await booted();
    const a = await tasks.start({ goal: "A", folder: join(work, "in", "a") }, ORIGIN);
    const b = await tasks.start({ goal: "B", folder: join(work, "in", "b") }, ELSEWHERE);
    const waiting = await tasks.start({ goal: "C", folder: join(work, "out") }, ORIGIN);
    await until(() => minds.requests.length === 2);
    expect(tasks.running()).toBe(2);

    settings = { ...settings, enabled: false };
    await tasks.modeChanged(false);
    for (const { id } of [a, b, waiting]) {
      expect((await tasks.get(id)).status).toBe("cancelled");
      expect((await onDisk(id))?.status).toBe("cancelled");
    }
    expect(tasks.running()).toBe(0);
    await until(() => reports.length === 3);
  });

  test("a start Assistant Mode turns off while it is being made is stopped with the rest", async () => {
    settings = { ...settings, folders: [work] };
    const tasks = await booted();
    const starting = tasks.start({ goal: "Late", folder: join(work, "late") }, ORIGIN);
    // Past its check of the mode, making its folder's grants and files.
    await Bun.sleep(0);
    settings = { ...settings, enabled: false };
    await tasks.modeChanged(false);
    const started = await starting;
    expect((await tasks.get(started.id)).status).toBe("cancelled");
    expect(tasks.running()).toBe(0);
    expect(minds.requests).toEqual([]);
  });
});

describe("reports", () => {
  test("a report that throws is tried again at the next start, and only until it lands", async () => {
    settings = { ...settings, folders: [work] };
    reportError = new Error("the chat is busy");
    const first = await booted();
    const { id } = await first.start({ goal: "Quick", folder: join(work, "q") }, ORIGIN);
    await until(() => reports.length === 1);
    await first.stop();
    expect(await onDisk(id)).not.toHaveProperty("reported");
    expect(logs.lines().some((line) => line.startsWith("ERROR") && line.includes(id))).toBe(true);

    reportError = null;
    const second = await booted();
    await until(async () => (await onDisk(id))?.reported === true);
    expect(reports.map((each) => each.id)).toEqual([id, id]);
    await second.stop();

    await booted();
    await Bun.sleep(30);
    expect(reports).toHaveLength(2);
  });

  test("laplace-task's tasks are never listed, marked, resumed or reported", async () => {
    const ended = await seed({
      status: "succeeded",
      outcome: { status: "succeeded", report: "Done." },
      endedAt: clock,
      chat: undefined,
    });
    const running = await seed({ status: "running", chat: undefined });
    const interrupted = await seed({ status: "interrupted", chat: undefined });
    const tasks = await booted();
    await Bun.sleep(30);

    expect(await tasks.list()).toEqual([]);
    for (const { id } of [ended, running, interrupted]) {
      expect((await refused(tasks.get(id))).code).toBe("unknown-task");
      expect((await refused(tasks.cancel(id))).code).toBe("unknown-task");
      expect((await refused(tasks.continue(id))).code).toBe("unknown-task");
    }
    await tasks.modeChanged(false);
    expect((await onDisk(running.id))?.status).toBe("running");
    expect((await onDisk(interrupted.id))?.status).toBe("interrupted");
    expect(await onDisk(ended.id)).not.toHaveProperty("reported");
    expect(reports).toEqual([]);
    expect(minds.made).toEqual([]);
  });
});

describe("reading tasks", () => {
  test("lists the app's tasks newest first, or one chat's", async () => {
    const tasks = await booted();
    const first = await tasks.start({ goal: "First", folder: join(work, "1") }, ORIGIN);
    clock += 1000;
    const second = await tasks.start({ goal: "Second", folder: join(work, "2") }, ELSEWHERE);
    clock += 1000;
    const third = await tasks.start({ goal: "Third", folder: join(work, "3") }, ORIGIN);
    expect((await tasks.list()).map((each) => each.id)).toEqual([third.id, second.id, first.id]);
    expect((await tasks.list({ chat: ORIGIN.id })).map((each) => each.id)).toEqual([
      third.id,
      first.id,
    ]);
    expect(await tasks.list({ chat: "nope" })).toEqual([]);

    // A new manager reads the same from disk.
    const again = manager();
    expect(await again.list()).toEqual(await tasks.list());
  });

  test("events: the transcript from an offset, then each line as it is stored, until the run stops", async () => {
    settings = { ...settings, folders: [work] };
    const first = deferred();
    const second = deferred();
    minds.script("Watch", [
      held(first.promise, calls([call("c1", "write", { path: "w.txt", content: "w" })])),
      held(second.promise, says("Watched.")),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Watch", folder: join(work, "w") }, ORIGIN);
    await until(() => minds.for("Watch").length === 1);

    const reader = (await tasks.events(id, 0)).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readLines = async (count: number): Promise<void> => {
      while (text.split("\n").length - 1 < count) {
        const { value, done } = await reader.read();
        if (done) throw new Error("ended early");
        text += decoder.decode(value);
      }
    };
    await readLines(1);
    first.resolve();
    // Its first turn's lines, while the second request holds the run.
    await readLines(4);
    expect((await tasks.get(id)).status).toBe("running");
    second.resolve();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const path = join(tasksDir(), id, "transcript.jsonl");
    expect(text).toBe(readFileSync(path, "utf8"));
    expect(types(id).at(-1)).toBe("end");

    // From the middle: the lines after the offset, then the end, since it no longer runs.
    const firstLine = Buffer.byteLength(`${text.split("\n")[0]}\n`);
    expect(await new Response(await tasks.events(id, firstLine)).text()).toBe(
      text.slice(text.indexOf("\n") + 1),
    );
    const past = await refused(tasks.events(id, Buffer.byteLength(text) + 1));
    expect([past.status, past.code]).toEqual([416, "range-not-satisfiable"]);
    expect((await refused(tasks.events(newTaskId(), 0))).code).toBe("unknown-task");
  });
});

describe("what she sees of a task", () => {
  test("snapshotsOf: a chat's tasks as they stand, oldest first, at once; none before the first load", async () => {
    const seeded = await seed({ status: "interrupted" });
    problem = "No key";
    const tasks = manager();
    expect(tasks.snapshotsOf(ORIGIN.id)).toEqual([]);
    await tasks.boot();
    expect(tasks.snapshotsOf(ORIGIN.id)).toEqual([await tasks.get(seeded.id)]);

    problem = null;
    clock += 1000;
    const first = await tasks.start({ goal: "First", folder: join(work, "1") }, ORIGIN);
    await tasks.start({ goal: "Elsewhere", folder: join(work, "2") }, ELSEWHERE);
    clock += 1000;
    const second = await tasks.start({ goal: "Second", folder: join(work, "3") }, ORIGIN);
    expect(tasks.snapshotsOf(ORIGIN.id).map((each) => each.id)).toEqual([
      seeded.id,
      first.id,
      second.id,
    ]);
    await tasks.cancel(first.id);
    expect(tasks.snapshotsOf(ORIGIN.id)[1]?.status).toBe("cancelled");
    expect(tasks.snapshotsOf("nope")).toEqual([]);
  });

  test("its latest step: the tool a call started, and its path, url or pattern, else its JSON", async () => {
    settings = { ...settings, folders: [work] };
    const first = deferred();
    const second = deferred();
    const items = [{ text: "x".repeat(150), status: "pending" }];
    minds.script("Steps", [
      calls([call("w1", "write", { path: "a.txt", content: "a" })]),
      held(first.promise, calls([call("f1", "find", { pattern: "*.txt" })])),
      held(second.promise, calls([call("t1", "todo", { items })])),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Steps", folder: join(work, "steps") }, ORIGIN);
    expect((await tasks.get(id)).step).toBeUndefined();

    await until(async () => (await tasks.get(id)).step !== undefined);
    expect((await tasks.get(id)).step).toEqual({ tool: "write", head: "a.txt" });
    first.resolve();
    await until(async () => (await tasks.get(id)).step?.tool === "find");
    expect((await tasks.get(id)).step).toEqual({ tool: "find", head: "*.txt" });
    second.resolve();
    const ended = await reach(tasks, id, "succeeded");
    const json = JSON.stringify({ items });
    expect(ended.step).toEqual({ tool: "todo", head: `${json.slice(0, 120)}…` });
    await until(async () => (await onDisk(id))?.status === "succeeded");
    expect((await onDisk(id))?.step).toEqual(ended.step);
  });

  test("a step a run takes up from its stored reply is named too", async () => {
    settings = { ...settings, folders: [work] };
    const url = "https://203.0.113.7/page";
    minds.script("Fetch later", [
      calls([call("f1", "web_fetch", { url, note: "the page" })]),
      says("Fetched."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Fetch later", folder: join(work, "f") }, ORIGIN);
    expect((await reach(tasks, id, "paused")).step).toBeUndefined();
    // A new manager, as after a restart: only the transcript holds the call.
    await tasks.stop();
    const again = await booted();
    await again.approve(id, { answer: "once" });
    expect((await reach(again, id, "succeeded")).step).toEqual({ tool: "web_fetch", head: url });
  });
});

describe("her steering", () => {
  const line = (text: string) => `${STEER_PREFIX}${text}`;

  test("queues her line on a running task, which its next request carries as a user line", async () => {
    settings = { ...settings, folders: [work] };
    const open = deferred();
    minds.script("Steered", [
      held(open.promise, calls([call("l1", "ls", { path: "." })])),
      says("Used tabs."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Steered", folder: join(work, "s") }, ORIGIN);
    await until(() => minds.for("Steered").length === 1);

    const steered = await tasks.steer(id, "  Use tabs.  ");
    expect(steered).toMatchObject({
      status: "running",
      inbox: { steer: [line("Use tabs.")], followUp: [] },
    });
    // At once, not within a second.
    expect((await onDisk(id))?.inbox).toEqual({ steer: [line("Use tabs.")], followUp: [] });

    open.resolve();
    await reach(tasks, id, "succeeded");
    expect(userLines(minds.for("Steered")[1]).at(-1)).toBe(line("Use tabs."));
    expect(types(id)).toEqual([
      "brief",
      "assistant",
      "tool-start",
      "tool-result",
      "steer",
      "assistant",
      "end",
    ]);
    await until(async () => (await onDisk(id))?.status === "succeeded");
    expect(await onDisk(id)).not.toHaveProperty("inbox");
  });

  test("on a task waiting at its start, it comes first once Allow runs it; a Deny drops it", async () => {
    const tasks = await booted();
    const allowed = await tasks.start({ goal: "Allowed", folder: join(work, "a") }, ORIGIN);
    expect((await tasks.steer(allowed.id, "Make it blue.")).status).toBe("awaiting-approval");
    await tasks.approve(allowed.id, { answer: "once" });
    await reach(tasks, allowed.id, "succeeded");
    expect(types(allowed.id)).toEqual(["brief", "steer", "assistant", "end"]);
    expect(userLines(minds.for("Allowed")[0]).at(-1)).toBe(line("Make it blue."));

    const denied = await tasks.start({ goal: "Denied", folder: join(work, "d") }, ORIGIN);
    await tasks.steer(denied.id, "Make it red.");
    const ended = await tasks.approve(denied.id, { answer: "deny" });
    expect(ended.status).toBe("cancelled");
    expect(ended).not.toHaveProperty("inbox");
    expect(types(denied.id)).toEqual(["brief", "end"]);
  });

  test("on a path question it waits through the answer, and goes ahead of the owner's", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "notes"));
    writeFileSync(join(work, "notes", "notes.txt"), "milk\n");
    const read = call("r1", "read", { path: join(work, "notes", "notes.txt") });
    minds.script("Asks", [calls([read]), calls([{ ...read, id: "r2" }]), says("Read.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Asks", folder: join(work, "site") }, ORIGIN);
    const { pending } = await reach(tasks, id, "paused");

    const steered = await tasks.steer(id, "Read the other notes too.");
    expect(steered).toMatchObject({ status: "paused", pending });
    await tasks.approve(id, { answer: "once", pending });
    await reach(tasks, id, "succeeded");
    expect(userLines(minds.for("Asks")[1]).slice(-2)).toEqual([
      line("Read the other notes too."),
      `The owner allowed read access to ${realpathSync(join(work, "notes"))}. Try again.`,
    ]);
  });

  test("a Deny on a path or a site question keeps it: the run reads it as it goes on", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "notes"));
    const notes = join(work, "notes", "notes.txt");
    writeFileSync(notes, "milk\n");
    minds.script("Asks", [calls([call("r1", "read", { path: notes })]), says("Couldn't.")]);
    minds.script("Site", [
      calls([call("f1", "web_fetch", { url: "https://203.0.113.9/" })]),
      says("Refused."),
    ]);
    const tasks = await booted();
    const asks = await tasks.start({ goal: "Asks", folder: join(work, "site") }, ORIGIN);
    const { pending } = await reach(tasks, asks.id, "paused");
    await tasks.steer(asks.id, "Read the other notes too.");
    expect(await tasks.approve(asks.id, { answer: "deny", pending })).toMatchObject({
      status: "running",
    });
    await reach(tasks, asks.id, "succeeded");
    expect(userLines(minds.for("Asks")[1]).slice(-2)).toEqual([
      line("Read the other notes too."),
      `The owner refused access to ${realpathSync(notes)}.`,
    ]);

    settings = { ...settings, folders: [work] };
    const site = await tasks.start({ goal: "Site", folder: join(work, "web") }, ORIGIN);
    const fetching = await reach(tasks, site.id, "paused");
    expect(fetching.pending).toEqual({ kind: "fetch", host: "203.0.113.9" });
    await tasks.steer(site.id, "Use the official docs instead.");
    await tasks.approve(site.id, { answer: "deny", pending: fetching.pending });
    await reach(tasks, site.id, "succeeded");
    expect(userLines(minds.for("Site")[1]).at(-1)).toBe(line("Use the official docs instead."));
  });

  test("on a spend pause it waits for Continue", async () => {
    settings = { ...settings, folders: [work] };
    minds.cost = 0.6;
    const ls = call("l1", "ls", { path: "." });
    minds.script("Spends", [calls([ls]), calls([{ ...ls, id: "l2" }]), says("Spent.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Spends", folder: join(work, "spend") }, ORIGIN);
    await reach(tasks, id, "paused");
    expect((await tasks.steer(id, "Stop at two pages.")).status).toBe("paused");
    await Bun.sleep(20);
    expect(minds.for("Spends")).toHaveLength(2);

    await tasks.continue(id);
    await reach(tasks, id, "succeeded");
    expect(userLines(minds.for("Spends")[2]).at(-1)).toBe(line("Stop at two pages."));
  });

  test("on an interrupted task it is kept in task.json through a restart", async () => {
    const seeded = await seed({ status: "interrupted" });
    problem = "No key";
    const first = await booted();
    await first.steer(seeded.id, "Use the old logo.");
    expect((await onDisk(seeded.id))?.inbox).toEqual({
      steer: [line("Use the old logo.")],
      followUp: [],
    });
    await first.stop();

    problem = null;
    const second = await booted();
    await reach(second, seeded.id, "succeeded");
    expect(userLines(minds.for("Seeded")[0]).at(-1)).toBe(line("Use the old logo."));
  });

  test("an ended task is refused, and nothing changes", async () => {
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Gone", folder: join(work, "g") }, ORIGIN);
    await tasks.cancel(id);
    await until(async () => (await onDisk(id))?.reported === true);
    const before = await onDisk(id);

    const ended = await refused(tasks.steer(id, "Too late."));
    expect([ended.status, ended.code, ended.message]).toEqual([
      409,
      "conflict",
      "The task has ended (cancelled)",
    ]);
    expect(await onDisk(id)).toEqual(before);
    expect(types(id)).toEqual(["brief", "end"]);
    expect((await refused(tasks.steer(newTaskId(), "Anyone?"))).code).toBe("unknown-task");
  });

  test("the text is stripped, and none or over 2,000 characters is refused", async () => {
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Texts", folder: join(work, "t") }, ORIGIN);
    const blank = await refused(tasks.steer(id, " \n "));
    expect([blank.status, blank.code]).toEqual([400, "bad-request"]);
    const long = await refused(tasks.steer(id, "x".repeat(2001)));
    expect([long.status, long.code, long.message]).toEqual([
      400,
      "bad-request",
      "The text to pass on is over 2,000 characters.",
    ]);
    expect(await tasks.get(id)).not.toHaveProperty("inbox");
    // Characters, not UTF-16 units or bytes.
    const wide = "字".repeat(2000);
    expect((await tasks.steer(id, wide)).inbox?.steer).toEqual([line(wide)]);
  });
});

describe("waiting", () => {
  /** A manager whose waiting hook records each snapshot it is called with. */
  async function watched(): Promise<{ tasks: TaskManager; waits: TaskSnapshot[] }> {
    const waits: TaskSnapshot[] = [];
    const tasks = manager({ waiting: (snapshot) => waits.push(snapshot) });
    await tasks.boot();
    return { tasks, waits };
  }

  test("is called once at each pause, with the paused snapshot", async () => {
    settings = { ...settings, folders: [join(work, "in")] };
    mkdirSync(join(work, "notes"));
    writeFileSync(join(work, "notes", "a.txt"), "a\n");
    const ls = call("l1", "ls", { path: "." });
    minds.script("Path", [calls([call("r1", "read", { path: join(work, "notes", "a.txt") })])]);
    minds.script("Site", [calls([call("f1", "web_fetch", { url: "https://203.0.113.7/" })])]);
    minds.script("Spend", [calls([ls]), calls([{ ...ls, id: "l2" }])]);
    minds.script("Stall", [calls([ls]), calls([ls]), calls([ls])]);
    minds.script("Unpriced", [calls([ls])]);
    const { tasks, waits } = await watched();

    const paused: Record<string, unknown> = {};
    for (const goal of ["Path", "Site", "Spend", "Stall", "Unpriced"]) {
      minds.cost = goal === "Spend" ? 0.6 : goal === "Unpriced" ? null : 0;
      const { id } = await tasks.start({ goal, folder: join(work, "in", goal) }, ORIGIN);
      const snapshot = await reach(tasks, id, "paused");
      await until(() => waits.length === Object.keys(paused).length + 1);
      expect(waits.at(-1)).toEqual(snapshot);
      paused[goal] = snapshot.pending?.kind ?? snapshot.pause?.reason;
      await tasks.cancel(id);
    }
    expect(paused).toEqual({
      Path: "path",
      Site: "fetch",
      Spend: "spend",
      Stall: "stall",
      Unpriced: "unpriced",
    });
    await Bun.sleep(20);
    expect(waits).toHaveLength(5);
  });

  test("is never called at a start, an answer or an end", async () => {
    settings = { ...settings, folders: [join(work, "in")] };
    mkdirSync(join(work, "notes"));
    writeFileSync(join(work, "notes", "a.txt"), "a\n");
    const read = call("r1", "read", { path: join(work, "notes", "a.txt") });
    minds.script("Asks once", [calls([read]), calls([{ ...read, id: "r2" }]), says("Read.")]);
    const { tasks, waits } = await watched();

    const waiting = await tasks.start({ goal: "Outside", folder: join(work, "out") }, ORIGIN);
    expect(waiting.status).toBe("awaiting-approval");
    await tasks.approve(waiting.id, { answer: "once" });
    await reach(tasks, waiting.id, "succeeded");
    expect(waits).toEqual([]);

    const { id } = await tasks.start({ goal: "Asks once", folder: join(work, "in", "x") }, ORIGIN);
    await reach(tasks, id, "paused");
    await until(() => waits.length === 1);
    await tasks.approve(id, { answer: "once" });
    await reach(tasks, id, "succeeded");
    await until(() => reports.length === 2);
    await Bun.sleep(20);
    expect(waits.map((each) => each.status)).toEqual(["paused"]);
  });

  test("a pause a Stop already asked to end is not one", async () => {
    settings = { ...settings, folders: [join(work, "site")] };
    mkdirSync(join(work, "notes"));
    writeFileSync(join(work, "notes", "a.txt"), "a\n");
    minds.script("Stopped", [calls([call("r1", "read", { path: join(work, "notes", "a.txt") })])]);
    const { tasks, waits } = await watched();
    const { id } = await tasks.start({ goal: "Stopped", folder: join(work, "site", "s") }, ORIGIN);
    // The refused read's result is stored: the run is storing its pause now.
    const reader = (await tasks.events(id, 0)).getReader();
    let text = "";
    while (!text.includes('"type":"tool-result"')) {
      const { value, done } = await reader.read();
      if (done) throw new Error("ended early");
      text += new TextDecoder().decode(value);
    }
    await tasks.cancel(id);
    await reader.cancel();
    expect((await tasks.get(id)).status).toBe("cancelled");
    expect(types(id).slice(-2)).toEqual(["pause", "end"]);
    expect(waits).toEqual([]);
  });

  test("a throw is logged, and the pause stands", async () => {
    settings = { ...settings, folders: [work] };
    minds.script("Throws", [calls([call("f1", "web_fetch", { url: "https://203.0.113.7/" })])]);
    const tasks = manager({
      waiting: () => {
        throw new Error("no call to tell");
      },
    });
    await tasks.boot();
    const { id } = await tasks.start({ goal: "Throws", folder: join(work, "t") }, ORIGIN);
    expect((await reach(tasks, id, "paused")).pending).toEqual({
      kind: "fetch",
      host: "203.0.113.7",
    });
    await until(() => logs.lines().some((each) => each.startsWith("ERROR") && each.includes(id)));
    expect((await onDisk(id))?.status).toBe("paused");
    expect((await tasks.approve(id, { answer: "deny" })).status).toBe("running");
  });
});
