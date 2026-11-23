// Task notifications: what each says, under her name, in both languages, what its click asks of
// the page, and when the watch shows one.
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
  PersonaSummary,
  TaskPending,
  TaskSnapshot,
  TaskStatus,
} from "../../bot/src/local/api.ts";
import type { NoticeHandle } from "../src/main/background.ts";
import type { BackendState, ReadyState } from "../src/main/controller.ts";
import type { BackendFetch, BackendResponse } from "../src/main/quit-check.ts";
import { STRINGS } from "../src/main/strings.ts";
import {
  ENDED,
  followBackend,
  type Notice,
  type NoticeKind,
  noticeCommand,
  noticeText,
  TaskWatch,
  WAITING,
} from "../src/main/task-notices.ts";

const en = STRINGS.en;
const zh = STRINGS["zh-Hans"];
const CHAT = "0b7f5f2e-3c1d-4e8a-9f60-1a2b3c4d5e6f";
const TASK = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

const notice: Notice = {
  task: TASK,
  chat: CHAT,
  persona: "Milky Green",
  kind: "start",
  goal: "Write a React TodoMVC in one index.html",
};

describe("noticeText", () => {
  test("is titled with her name, and says the kind's line, then her goal", () => {
    expect(noticeText(notice, en)).toEqual({
      title: "Milky Green",
      body: "Waiting for your OK to start a task\nWrite a React TodoMVC in one index.html",
    });
    expect(noticeText({ ...notice, kind: "succeeded" }, en)).toEqual({
      title: "Milky Green",
      body: "Finished the task\nWrite a React TodoMVC in one index.html",
    });
  });

  test("says the line alone when there is no goal", () => {
    expect(noticeText({ ...notice, kind: "failed", goal: "" }, en).body).toBe("The task failed");
    expect(noticeText({ ...notice, kind: "failed", goal: "  " }, en).body).toBe("The task failed");
  });

  test("is titled Eidolon when her name is unknown", () => {
    expect(noticeText({ ...notice, persona: null }, en).title).toBe("Eidolon");
    expect(noticeText({ ...notice, persona: "" }, en).title).toBe("Eidolon");
    expect(noticeText({ ...notice, persona: null }, zh).title).toBe("Eidolon");
  });

  test("speaks the shell's language, her goal and name as they are", () => {
    const goal = "写一个 React TodoMVC，单文件 index.html";
    expect(noticeText({ ...notice, persona: "奶绿", kind: "command", goal }, zh)).toEqual({
      title: "奶绿",
      body: `等你同意运行一条命令\n${goal}`,
    });
    expect(noticeText({ ...notice, kind: "cancelled", goal: "" }, zh).body).toBe("任务已停止");
  });

  test("has a line for every kind, in both languages", () => {
    const kinds = Object.keys(en.notice);
    for (const strings of [en, zh]) {
      const bodies = kinds.map(
        (kind) => noticeText({ ...notice, kind: kind as Notice["kind"], goal: "" }, strings).body,
      );
      expect(new Set(bodies).size).toBe(kinds.length);
    }
  });
});

/** A server whose status answers `body`, recording each path asked for. */
function server(body: unknown, status = 200): { fetch: BackendFetch; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    fetch: async (path): Promise<BackendResponse> => {
      paths.push(path);
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
  };
}

describe("noticeCommand", () => {
  test("opens the task in its chat, or the Tasks page for a task without one", async () => {
    const { fetch, paths } = server({ activeCalls: 0 });
    expect(await noticeCommand(notice, fetch)).toBe(`open-task:${CHAT}:${TASK}`);
    expect(await noticeCommand({ ...notice, chat: null }, fetch)).toBe("tasks");
    expect(paths).toEqual(["/api/local/status", "/api/local/status"]);
  });

  test("asks nothing of the page while a call is live, or when the status doesn't count calls", async () => {
    for (const body of [{ activeCalls: 1 }, {}, { activeCalls: "0" }, null, []]) {
      expect(await noticeCommand(notice, server(body).fetch)).toBeNull();
    }
  });

  test("rejects when the status can't be read, or its ids aren't the server's", async () => {
    await expect(noticeCommand(notice, server({}, 503).fetch)).rejects.toThrow(
      "GET /api/local/status answered 503",
    );
    const failing: BackendFetch = async () => {
      throw new Error("no server is ready");
    };
    await expect(noticeCommand(notice, failing)).rejects.toThrow("no server is ready");
    await expect(
      noticeCommand({ ...notice, task: "../settings" }, server({ activeCalls: 0 }).fetch),
    ).rejects.toThrow();
  });
});

describe("followBackend", () => {
  const ready = (pid: number, owned = false): ReadyState => ({
    phase: "ready",
    origin: "http://127.0.0.1:7860",
    token: {} as ReadyState["token"],
    owned,
    pid,
  });

  /** What the watch is told across `states`. */
  function told(states: readonly BackendState[]): string[] {
    const calls: string[] = [];
    const follow = followBackend({
      ready: () => calls.push("ready"),
      stop: () => calls.push("stop"),
    });
    for (const state of states) follow(state);
    return calls;
  }

  test("a server's first ready starts the watch, and an attached server's idle hold leaves it be", () => {
    expect(
      told([
        { phase: "starting" },
        ready(41),
        { phase: "holding", owned: false },
        ready(41),
        { phase: "holding", owned: false },
        ready(41),
      ]),
    ).toEqual(["stop", "ready"]);
  });

  test("another server after a hold, a restart's included, starts it on a new baseline", () => {
    expect(told([ready(41), { phase: "holding", owned: false }, ready(42)])).toEqual([
      "ready",
      "ready",
    ]);
    expect(told([ready(41, true), { phase: "holding", owned: true }, ready(43, true)])).toEqual([
      "ready",
      "ready",
    ]);
    // Our own server at the attached one's address and process isn't the one followed.
    expect(told([ready(41), ready(41, true)])).toEqual(["ready", "ready"]);
  });

  test("no server stops it, and the same server after that starts it again", () => {
    const failed: BackendState = {
      phase: "failed",
      failure: { reason: "exited", code: 1, signal: null, stderr: [] },
    };
    expect(told([ready(41), failed, ready(41), { phase: "stopped" }])).toEqual([
      "ready",
      "stop",
      "ready",
      "stop",
    ]);
  });
});

const TASKS = "/api/local/tasks";
const PERSONAS = "/api/local/personas";
const TASK_B = "0193a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b";
const TASK_C = "0193a1b2-c3d4-7e5f-8a6b-2c3d4e5f6a7b";
const LETTERS = new Map([
  [TASK, "A"],
  [TASK_B, "B"],
  [TASK_C, "C"],
]);
const GOAL = notice.goal;
const MILKY: PersonaSummary = {
  id: "milky-green",
  name: "明前奶绿",
  shortName: "奶绿",
  template: true,
  own: true,
  avatar: false,
};
const RIN: PersonaSummary = { ...MILKY, id: "rin", name: "Rin", shortName: "Rin", template: false };

/** A task milky-green started in CHAT, running, as GET tasks answers. */
function snapshot(id: string, fields: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    v: 1,
    id,
    createdAt: 1_763_856_000_000,
    status: "running",
    chat: { id: CHAT, persona: MILKY.id, call: `call-${id.slice(-4)}` },
    brief: { goal: GOAL, deliverable: "index.html", folder: "/Users/t/todo", check: "Open it" },
    model: { account: "openrouter", model: "deepseek/deepseek-v4-flash" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
    ...fields,
  };
}

/** Paused on the owner's answer to `pending`. */
function asking(pending: TaskPending): Partial<TaskSnapshot> {
  return {
    status: "paused",
    pending,
    pause: { reason: "approval", detail: "It waits on the owner" },
  };
}

const START: Partial<TaskSnapshot> = { status: "awaiting-approval", pending: { kind: "start" } };
const RUN_TESTS = asking({ kind: "command", call: "call-1", command: "npm test", timeout: 120 });
const BUILD = asking({ kind: "command", call: "call-2", command: "npm run build", timeout: 120 });
const WRITE = asking({
  kind: "path",
  path: "/Users/t/.zshrc",
  access: "write",
  folder: "/Users/t",
});

/** A ready server's tasks and personas, each request it gets recorded. */
function taskServer() {
  const state = {
    tasks: [] as TaskSnapshot[],
    personas: [MILKY] as PersonaSummary[],
    /** A path's status other than 200, or `never`: no answer, even once its request is aborted. */
    fails: new Map<string, number | "never">(),
    /** What GET tasks answers in place of its tasks. */
    body: undefined as unknown,
    requests: [] as { readonly path: string; readonly signal: AbortSignal }[],
  };
  const fetch: BackendFetch = (path, { signal }) => {
    state.requests.push({ path, signal });
    const fail = state.fails.get(path);
    if (fail === "never") return new Promise<never>(() => {});
    const body =
      path === TASKS
        ? (state.body ?? { tasks: state.tasks })
        : { active: MILKY.id, personas: state.personas };
    const status = fail ?? 200;
    return Promise.resolve({ ok: status === 200, status, json: async () => body });
  };
  return Object.assign(state, {
    fetch,
    paths: () => state.requests.map(({ path }) => path),
    polls: () => state.requests.filter(({ path }) => path === TASKS).length,
  });
}

/** Lets every promise callback that waits on nothing else run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** setTimeout and clearTimeout on a clock that moves only when a test advances it. */
function clock() {
  let now = 0;
  let ids = 0;
  const due = new Map<number, { readonly at: number; readonly run: () => void }>();
  const timers = {
    setTimeout: ((run: () => void, ms = 0) => {
      ids += 1;
      due.set(ids, { at: now + ms, run });
      return ids;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id?: number) => {
      if (id !== undefined) due.delete(id);
    }) as unknown as typeof clearTimeout,
  };
  return {
    timers,
    /** How far off each timer set is, soonest first. */
    pending: (): number[] => [...due.values()].map(({ at }) => at - now).sort((a, b) => a - b),
    /** Moves the clock `ms` on, running each timer due meanwhile and whatever that starts. */
    async advance(ms: number): Promise<void> {
      const until = now + ms;
      for (;;) {
        await settle();
        let first: [number, { readonly at: number; readonly run: () => void }] | undefined;
        for (const entry of due)
          if (first === undefined || entry[1].at < first[1].at) first = entry;
        if (first === undefined || first[1].at > until) break;
        due.delete(first[0]);
        now = first[1].at;
        first[1].run();
      }
      now = until;
    },
  };
}

interface Shown {
  readonly notice: Notice;
  open: boolean;
}

/** A watch on taskServer() and clock(), with the notices it shows, its log and the focus. */
function watching() {
  const time = clock();
  const backend = taskServer();
  const shown: Shown[] = [];
  const lines: string[] = [];
  const app = { focused: false };
  const watch = new TaskWatch({
    fetch: backend.fetch,
    focused: () => app.focused,
    show: (notice): NoticeHandle => {
      const entry: Shown = { notice, open: true };
      shown.push(entry);
      return {
        close: () => {
          entry.open = false;
        },
      };
    },
    log: {
      info: (line) => lines.push(`info ${line}`),
      warn: (line) => lines.push(`warn ${line}`),
    },
    timers: time.timers,
  });
  return { time, backend, shown, lines, app, watch };
}

/** Each notice shown, oldest first: its task's letter, its kind, and whether it was closed. */
function told(shown: readonly Shown[]): string[] {
  return shown.map(
    ({ notice, open }) => `${LETTERS.get(notice.task)} ${notice.kind}${open ? "" : " closed"}`,
  );
}

/** What a watch that saw task A running at its baseline shows once A is as `change` says. */
async function afterChange(change: Partial<TaskSnapshot>) {
  const { time, backend, shown, watch } = watching();
  backend.tasks = [snapshot(TASK)];
  watch.ready();
  await time.advance(0);
  backend.tasks = [snapshot(TASK, change)];
  await time.advance(3_000);
  watch.stop();
  return { notices: shown.map((entry) => entry.notice), paths: backend.paths() };
}

describe("TaskWatch", () => {
  test("the first answer after ready() is the baseline, which notifies nothing", async () => {
    const { time, backend, shown, watch } = watching();
    backend.tasks = [
      snapshot(TASK, RUN_TESTS),
      snapshot(TASK_B, { status: "succeeded" }),
      snapshot(TASK_C, START),
    ];
    watch.ready();
    await time.advance(0);
    await time.advance(30_000);
    expect(backend.paths()).toEqual([TASKS, TASKS]);
    expect(shown).toEqual([]);
    watch.stop();
  });

  test("a task that comes to wait on the owner is told once, under her name, with her goal", async () => {
    const { time, backend, shown, watch } = watching();
    backend.tasks = [snapshot(TASK)];
    watch.ready();
    await time.advance(0);
    backend.tasks = [snapshot(TASK, RUN_TESTS), snapshot(TASK_B, START)];
    await time.advance(3_000);
    expect(shown.map((entry) => entry.notice)).toEqual([
      { task: TASK, chat: CHAT, persona: "明前奶绿", kind: "command", goal: GOAL },
      { task: TASK_B, chat: CHAT, persona: "明前奶绿", kind: "start", goal: GOAL },
    ]);
    await time.advance(30_000);
    expect(told(shown)).toEqual(["A command", "B start"]);
    expect(backend.paths()).toEqual([TASKS, TASKS, PERSONAS, TASKS]);
    watch.stop();
  });

  test("names what it waits for, or how it ended, and nothing a worker wrote", async () => {
    const cases: [NoticeKind, Partial<TaskSnapshot>][] = [
      ["start", START],
      ["read", asking({ kind: "path", path: "/Users/t/notes.md", access: "read" })],
      ["write", WRITE],
      ["fetch", asking({ kind: "fetch", host: "example.com" })],
      ["command", RUN_TESTS],
      [
        "mcp",
        asking({
          kind: "mcp",
          server: "files",
          tool: "remove",
          call: "call-3",
          key: "k",
          args: [],
        }),
      ],
      ["spend", { status: "paused", pause: { reason: "spend", detail: "It spent $1.02" } }],
      ["stall", { status: "paused", pause: { reason: "stall", detail: "Three turns alike" } }],
      ["unpriced", { status: "paused", pause: { reason: "unpriced", detail: "No price" } }],
      ["interrupted", { status: "interrupted" }],
      ["waiting", { status: "paused", pause: { reason: "approval", detail: "" } }],
      ["succeeded", { status: "succeeded", outcome: { status: "succeeded", report: "Wrote it" } }],
      ["failed", { status: "failed", outcome: { status: "failed", error: "The model refused" } }],
      ["cancelled", { status: "cancelled", outcome: { status: "cancelled" } }],
    ];
    for (const [kind, change] of cases) {
      const { notices } = await afterChange(change);
      expect([kind, notices]).toEqual([
        kind,
        [{ task: TASK, chat: CHAT, persona: "明前奶绿", kind, goal: GOAL }],
      ]);
    }
  });

  test("a new question replaces the task's notice, and an answered one is closed", async () => {
    const { time, backend, shown, watch } = watching();
    backend.tasks = [snapshot(TASK, RUN_TESTS)];
    watch.ready();
    await time.advance(0);
    backend.tasks = [snapshot(TASK, BUILD)];
    await time.advance(30_000);
    expect(told(shown)).toEqual(["A command"]);
    backend.tasks = [snapshot(TASK, WRITE)];
    await time.advance(30_000);
    expect(told(shown)).toEqual(["A command closed", "A write"]);
    backend.tasks = [snapshot(TASK)];
    await time.advance(30_000);
    expect(told(shown)).toEqual(["A command closed", "A write closed"]);
    backend.tasks = [snapshot(TASK, BUILD)];
    await time.advance(3_000);
    expect(told(shown)).toEqual(["A command closed", "A write closed", "A command"]);
    watch.stop();
  });

  test("a pause after a Continue the polls missed is told anew", async () => {
    const { time, backend, shown, watch } = watching();
    const spent = (detail: string): Partial<TaskSnapshot> => ({
      status: "paused",
      pause: { reason: "spend", detail },
    });
    backend.tasks = [snapshot(TASK)];
    watch.ready();
    await time.advance(0);
    backend.tasks = [snapshot(TASK, spent("Spent $1.02; it pauses at 1."))];
    await time.advance(3_000);
    backend.tasks = [snapshot(TASK, spent("Spent $2.01; it pauses at 1."))];
    await time.advance(30_000);
    expect(told(shown)).toEqual(["A spend closed", "A spend"]);
    backend.tasks = [
      snapshot(TASK, { status: "paused", pause: { reason: "stall", detail: "The same calls" } }),
    ];
    await time.advance(30_000);
    expect(told(shown)).toEqual(["A spend closed", "A spend closed", "A stall"]);
    watch.stop();
  });

  test("an end replaces the task's notice and stays open, and one ended before it was seen is told", async () => {
    const { time, backend, shown, watch } = watching();
    backend.tasks = [snapshot(TASK), snapshot(TASK_C, { status: "cancelled" })];
    watch.ready();
    await time.advance(0);
    backend.tasks = [snapshot(TASK, RUN_TESTS), snapshot(TASK_C, { status: "cancelled" })];
    await time.advance(3_000);
    backend.tasks = [
      snapshot(TASK, { status: "succeeded" }),
      snapshot(TASK_B, { status: "failed" }),
      snapshot(TASK_C, { status: "cancelled" }),
    ];
    await time.advance(30_000);
    expect(told(shown)).toEqual(["A command closed", "A succeeded", "B failed"]);
    await time.advance(60_000);
    watch.stop();
    expect(told(shown)).toEqual(["A command closed", "A succeeded", "B failed"]);
  });

  test("shows nothing while the window is focused, yet closes what that outdates and counts what it saw", async () => {
    const { time, backend, shown, app, watch } = watching();
    backend.tasks = [snapshot(TASK), snapshot(TASK_B)];
    watch.ready();
    await time.advance(0);
    backend.tasks = [snapshot(TASK, RUN_TESTS), snapshot(TASK_B)];
    await time.advance(3_000);
    expect(told(shown)).toEqual(["A command"]);
    app.focused = true;
    backend.tasks = [snapshot(TASK, BUILD), snapshot(TASK_B, WRITE)];
    await time.advance(3_000);
    expect(told(shown)).toEqual(["A command closed"]);
    app.focused = false;
    await time.advance(30_000);
    expect(told(shown)).toEqual(["A command closed"]);
    backend.tasks = [snapshot(TASK, { status: "succeeded" }), snapshot(TASK_B, WRITE)];
    await time.advance(30_000);
    expect(told(shown)).toEqual(["A command closed", "A succeeded"]);
    watch.stop();
  });

  test("reads her name once a baseline, and again for a persona it doesn't know", async () => {
    const { time, backend, shown, watch } = watching();
    const rins = { chat: { id: CHAT, persona: RIN.id, call: "call-rin" } };
    backend.tasks = [snapshot(TASK), snapshot(TASK_B, rins)];
    watch.ready();
    await time.advance(0);
    backend.tasks = [snapshot(TASK, RUN_TESTS), snapshot(TASK_B, rins)];
    await time.advance(3_000);
    backend.tasks = [snapshot(TASK, { status: "succeeded" }), snapshot(TASK_B, rins)];
    await time.advance(3_000);
    expect(backend.paths()).toEqual([TASKS, TASKS, PERSONAS, TASKS]);
    backend.personas = [MILKY, RIN];
    backend.tasks = [
      snapshot(TASK, { status: "succeeded" }),
      snapshot(TASK_B, { ...rins, ...WRITE }),
    ];
    await time.advance(3_000);
    expect(backend.paths()).toEqual([TASKS, TASKS, PERSONAS, TASKS, TASKS, PERSONAS]);
    expect(shown.map(({ notice }) => [notice.kind, notice.persona])).toEqual([
      ["command", "明前奶绿"],
      ["succeeded", "明前奶绿"],
      ["write", "Rin"],
    ]);
    watch.ready();
    await time.advance(0);
    backend.tasks = [
      snapshot(TASK, { status: "succeeded" }),
      snapshot(TASK_B, { ...rins, ...RUN_TESTS }),
    ];
    await time.advance(30_000);
    expect(backend.paths().slice(-3)).toEqual([TASKS, TASKS, PERSONAS]);
    expect(told(shown).at(-1)).toBe("B command");
    watch.stop();
  });

  test("goes without her name when the personas can't be read, or don't list her", async () => {
    const { time, backend, shown, lines, watch } = watching();
    const strangers = { chat: { id: CHAT, persona: "gone", call: "call-gone" } };
    backend.fails.set(PERSONAS, 500);
    backend.tasks = [snapshot(TASK), snapshot(TASK_B, strangers)];
    watch.ready();
    await time.advance(0);
    backend.tasks = [snapshot(TASK, RUN_TESTS), snapshot(TASK_B, strangers)];
    await time.advance(3_000);
    expect(lines).toEqual([
      "warn Eidolon: notifications couldn't read the personas' names: GET /api/local/personas answered 500",
    ]);
    backend.fails.delete(PERSONAS);
    backend.tasks = [snapshot(TASK, RUN_TESTS), snapshot(TASK_B, { ...strangers, ...WRITE })];
    await time.advance(3_000);
    expect(shown.map(({ notice }) => [notice.kind, notice.persona])).toEqual([
      ["command", null],
      ["write", null],
    ]);
    expect(backend.paths().filter((path) => path === PERSONAS)).toHaveLength(2);
    watch.stop();
  });

  test("a task without a chat is told without a name, and asks for none", async () => {
    const { notices, paths } = await afterChange({ ...START, chat: undefined });
    expect(notices).toEqual([{ task: TASK, chat: null, persona: null, kind: "start", goal: GOAL }]);
    expect(paths).toEqual([TASKS, TASKS]);
  });

  test("puts her goal on one line, without control, format or bidi characters, cut at 80", async () => {
    const goals: [unknown, string][] = [
      [" Fix\u202Ethe\u0007bug\u2028now\r\n\t\u200Bplease\u2029", "Fix the bug now please"],
      ["字".repeat(80), "字".repeat(80)],
      ["字".repeat(81), `${"字".repeat(80)}…`],
      [`${"a".repeat(79)} bc`, `${"a".repeat(79)}…`],
      ["𝒳".repeat(81), `${"𝒳".repeat(80)}…`],
      [42, ""],
    ];
    for (const [goal, line] of goals) {
      const brief = { ...snapshot(TASK).brief, goal } as TaskSnapshot["brief"];
      const { notices } = await afterChange({ ...START, brief });
      expect([goal, notices.map((each) => each.goal)]).toEqual([goal, [line]]);
    }
    const { notices } = await afterChange({ ...START, brief: undefined });
    expect(notices.map((each) => each.goal)).toEqual([""]);
  });

  test("asks every 3 s while a task runs, and every 30 s otherwise", async () => {
    const { time, backend, app, watch } = watching();
    app.focused = true;
    backend.tasks = [snapshot(TASK)];
    watch.ready();
    expect(time.pending()).toEqual([0]);
    await time.advance(0);
    expect(time.pending()).toEqual([3_000]);
    await time.advance(2_999);
    expect(backend.polls()).toBe(1);
    await time.advance(1);
    expect(backend.polls()).toBe(2);
    backend.tasks = [snapshot(TASK, RUN_TESTS)];
    await time.advance(3_000);
    expect(time.pending()).toEqual([30_000]);
    await time.advance(29_999);
    expect(backend.polls()).toBe(3);
    await time.advance(1);
    expect(backend.polls()).toBe(4);
    watch.stop();
  });

  test("a failure logs once a streak, tries again in 30 s, and the first answer after is the baseline", async () => {
    const { time, backend, shown, lines, watch } = watching();
    backend.fails.set(TASKS, 503);
    watch.ready();
    await time.advance(0);
    const failed = "warn Eidolon: notifications couldn't read the tasks:";
    expect(lines).toEqual([`${failed} GET /api/local/tasks answered 503`]);
    expect(time.pending()).toEqual([30_000]);
    await time.advance(30_000);
    expect(backend.polls()).toBe(2);
    expect(lines).toHaveLength(1);
    backend.fails.delete(TASKS);
    backend.tasks = [snapshot(TASK), snapshot(TASK_B, RUN_TESTS)];
    await time.advance(30_000);
    expect(shown).toEqual([]);
    expect(lines.at(-1)).toBe("info Eidolon: notifications read the tasks again");
    expect(time.pending()).toEqual([3_000]);
    backend.body = { error: { code: "unknown-route" } };
    await time.advance(3_000);
    expect(lines.at(-1)).toBe(`${failed} GET /api/local/tasks: no task list`);
    expect(lines).toHaveLength(3);
    watch.stop();
  });

  test("a request with no answer in 10 s is aborted, and fails", async () => {
    const { time, backend, lines, watch } = watching();
    backend.fails.set(TASKS, "never");
    watch.ready();
    await time.advance(0);
    await time.advance(9_999);
    expect(backend.requests[0]?.signal.aborted).toBe(false);
    expect(lines).toEqual([]);
    await time.advance(1);
    expect(backend.requests[0]?.signal.aborted).toBe(true);
    expect(lines).toEqual([
      "warn Eidolon: notifications couldn't read the tasks: no answer in 10 s",
    ]);
    expect(time.pending()).toEqual([30_000]);
    watch.stop();
  });

  test("stop() cancels the next poll and the request in flight, and closes no notice", async () => {
    const { time, backend, shown, lines, watch } = watching();
    backend.tasks = [snapshot(TASK)];
    watch.ready();
    await time.advance(0);
    backend.tasks = [snapshot(TASK, RUN_TESTS)];
    await time.advance(3_000);
    watch.stop();
    expect(time.pending()).toEqual([]);
    await time.advance(60_000);
    expect(backend.polls()).toBe(2);
    expect(told(shown)).toEqual(["A command"]);
    backend.fails.set(TASKS, "never");
    watch.ready();
    await time.advance(0);
    watch.stop();
    await time.advance(0);
    expect(backend.requests.at(-1)?.signal.aborted).toBe(true);
    expect(time.pending()).toEqual([]);
    expect(lines).toEqual([]);
    expect(told(shown)).toEqual(["A command"]);
  });

  test("stop() while her name is read shows nothing, logs nothing and asks nothing more", async () => {
    const { time, backend, shown, lines, watch } = watching();
    backend.tasks = [snapshot(TASK)];
    watch.ready();
    await time.advance(0);
    backend.fails.set(PERSONAS, "never");
    backend.tasks = [snapshot(TASK, RUN_TESTS)];
    await time.advance(3_000);
    expect(backend.paths()).toEqual([TASKS, TASKS, PERSONAS]);
    watch.stop();
    await time.advance(60_000);
    expect(backend.requests.at(-1)?.signal.aborted).toBe(true);
    expect(backend.paths()).toEqual([TASKS, TASKS, PERSONAS]);
    expect(shown).toEqual([]);
    expect(lines).toEqual([]);
    expect(time.pending()).toEqual([]);
  });

  test("ready() again drops the poll in flight and starts on a new baseline", async () => {
    const { time, backend, shown, lines, watch } = watching();
    backend.tasks = [snapshot(TASK)];
    watch.ready();
    await time.advance(0);
    backend.fails.set(TASKS, "never");
    await time.advance(3_000);
    const dropped = backend.requests.at(-1);
    backend.fails.delete(TASKS);
    backend.tasks = [snapshot(TASK, { status: "succeeded" }), snapshot(TASK_B, RUN_TESTS)];
    watch.ready();
    expect(dropped?.signal.aborted).toBe(true);
    await time.advance(0);
    expect(shown).toEqual([]);
    backend.tasks = [
      snapshot(TASK, { status: "succeeded" }),
      snapshot(TASK_B),
      snapshot(TASK_C, START),
    ];
    await time.advance(30_000);
    expect(told(shown)).toEqual(["C start"]);
    expect(lines).toEqual([]);
    watch.stop();
  });

  test("a new baseline closes the waits that ended while no server was followed, and shows nothing", async () => {
    const { time, backend, shown, watch } = watching();
    backend.tasks = [snapshot(TASK), snapshot(TASK_C)];
    watch.ready();
    await time.advance(0);
    backend.tasks = [
      snapshot(TASK, RUN_TESTS),
      snapshot(TASK_B, START),
      snapshot(TASK_C, { status: "succeeded" }),
    ];
    await time.advance(3_000);
    expect(told(shown)).toEqual(["A command", "B start", "C succeeded"]);
    // Allowed and denied on their cards before the next poll, then Settings' Restart.
    watch.stop();
    backend.tasks = [
      snapshot(TASK),
      snapshot(TASK_B, { status: "cancelled" }),
      snapshot(TASK_C, { status: "succeeded" }),
    ];
    watch.ready();
    await time.advance(0);
    expect(told(shown)).toEqual(["A command closed", "B start closed", "C succeeded"]);
    backend.tasks = [snapshot(TASK, BUILD), ...backend.tasks.slice(1)];
    await time.advance(3_000);
    expect(told(shown)).toEqual(["A command closed", "B start closed", "C succeeded", "A command"]);
    watch.stop();
  });

  test("another server's first failure is logged, though the last one's streak went on", async () => {
    const { time, backend, lines, watch } = watching();
    const failed =
      "warn Eidolon: notifications couldn't read the tasks: GET /api/local/tasks answered 503";
    backend.fails.set(TASKS, 503);
    watch.ready();
    await time.advance(0);
    watch.ready();
    await time.advance(0);
    backend.fails.delete(TASKS);
    watch.ready();
    await time.advance(0);
    expect(lines).toEqual([failed, failed]);
    watch.stop();
  });

  test("ends each request once it is answered, so a refusal's unread body holds no connection", async () => {
    const { time, backend, watch } = watching();
    backend.fails.set(TASKS, 503);
    watch.ready();
    await time.advance(0);
    expect(backend.requests.map(({ signal }) => signal.aborted)).toEqual([true]);
    watch.stop();
  });
});

/** Every status a task has. */
const STATUSES = Object.keys({
  "awaiting-approval": null,
  running: null,
  paused: null,
  interrupted: null,
  succeeded: null,
  failed: null,
  cancelled: null,
} satisfies Record<TaskStatus, null>) as TaskStatus[];

// A computed path, so the typecheck doesn't follow it into apps/web, whose "@/" imports it can't
// resolve.
const WEB_TASK_STATE = join(import.meta.dirname, "../../web/src/features/tasks/state.ts");

test("the watch takes the statuses the web app's cards wait and end on", async () => {
  const web = (await import(WEB_TASK_STATE)) as {
    ended(status: TaskStatus): boolean;
    waitsOnOwner(task: { status: TaskStatus }): boolean;
  };
  for (const status of STATUSES) {
    expect([status, WAITING.has(status), ENDED.has(status)]).toEqual([
      status,
      web.waitsOnOwner({ status }),
      web.ended(status),
    ]);
  }
});
