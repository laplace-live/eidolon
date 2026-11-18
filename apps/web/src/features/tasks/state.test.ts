import { describe, expect, test } from "bun:test";
import type { ChatDisplay } from "@eidolon/chat";
import type { TaskPending, TaskSnapshot, TaskStatus } from "@/lib/api";
import { STEER_PREFIX } from "../../../../bot/src/local/api.ts";
import {
  barChoice,
  ended,
  endedSince,
  followsSteps,
  keepsLiveSteps,
  listOrder,
  modeRefuses,
  needsAnswer,
  nextPauseAt,
  offers,
  pathIn,
  pauseKind,
  queuedLines,
  RUNNING_POLL_MS,
  stepsShown,
  stopChoice,
  tasksPoll,
  WAITING_POLL_MS,
  waitingCount,
  waitingFor,
  waitsOnOwner,
} from "./state";

const STATUSES: readonly TaskStatus[] = [
  "awaiting-approval",
  "running",
  "paused",
  "interrupted",
  "succeeded",
  "failed",
  "cancelled",
];

const path: TaskPending = { kind: "path", path: "/x/notes.txt", access: "read" };

/** A snapshot with what a test names, the rest as a fresh task's. */
function task(id: string, status: TaskStatus, more: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    v: 1,
    id,
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    status,
    chat: { id: "chat", persona: "mio", call: `call-${id}` },
    brief: { goal: id, deliverable: id, folder: "/Users/me/todo", check: "Check it" },
    model: { account: "openrouter", model: "x-ai/grok-5" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
    ...more,
  };
}

test("only succeeded, failed and cancelled tasks have ended", () => {
  expect(STATUSES.filter(ended)).toEqual(["succeeded", "failed", "cancelled"]);
});

describe("waiting on the owner", () => {
  test("a task waiting to start, paused, or interrupted waits on the owner", () => {
    expect(STATUSES.filter((status) => waitsOnOwner({ status }))).toEqual([
      "awaiting-approval",
      "paused",
      "interrupted",
    ]);
  });

  test("an answer is asked for while a start, a path or a site is pending", () => {
    expect(needsAnswer({ status: "awaiting-approval", pending: { kind: "start" } })).toBe(true);
    expect(needsAnswer({ status: "paused", pending: path })).toBe(true);
    expect(needsAnswer({ status: "paused", pending: { kind: "fetch", host: "a.com" } })).toBe(true);
    // A pause that only waits on Continue, and a pending left on a task that went on, ask nothing.
    expect(needsAnswer({ status: "paused" })).toBe(false);
    for (const status of STATUSES.filter((s) => s !== "awaiting-approval" && s !== "paused")) {
      expect(needsAnswer({ status, pending: path })).toBe(false);
    }
  });

  test("what each waits for", () => {
    const at = (more: Partial<TaskSnapshot>, status: TaskStatus = "paused") =>
      waitingFor(task("1", status, more));
    expect(at({ pending: { kind: "start" } }, "awaiting-approval")).toEqual({
      kind: "start",
      folder: "/Users/me/todo",
    });
    // With the folder an Allow grants, which the waiting line names.
    expect(
      at({ pending: { kind: "path", path: "/etc/x", access: "write", folder: "/etc" } }),
    ).toEqual({ kind: "path", path: "/etc/x", access: "write", folder: "/etc" });
    expect(at({ pending: { kind: "path", path: "/Users/me/.zshrc", access: "read" } })).toEqual({
      kind: "path",
      path: "/Users/me/.zshrc",
      access: "read",
    });
    expect(at({ pending: { kind: "fetch", host: "a.com" } })).toEqual({
      kind: "fetch",
      host: "a.com",
    });
    expect(at({ pause: { reason: "spend", detail: "" }, spentUsd: 1.02 })).toEqual({
      kind: "spend",
      spentUsd: 1.02,
    });
    expect(at({ pause: { reason: "stall", detail: "" } })).toEqual({ kind: "stall" });
    expect(at({ pause: { reason: "unpriced", detail: "" } })).toEqual({ kind: "unpriced" });
    // A pause it can't name, laplace-task's paused outcome included, waits to go on.
    expect(at({})).toEqual({ kind: "paused" });
    expect(at({ outcome: { status: "paused", reason: "stall", detail: "" } })).toEqual({
      kind: "stall",
    });
    expect(at({}, "interrupted")).toEqual({ kind: "interrupted" });
    expect(at({ pending: { kind: "start" } }, "running")).toBeNull();
    expect(at({}, "succeeded")).toBeNull();
  });
});

describe("what the card offers", () => {
  test("a running task: Stop", () => {
    expect(offers({ status: "running" })).toEqual({ approve: false, continue: false, stop: true });
  });

  test("a task waiting on an answer: the answers, and Stop", () => {
    expect(offers({ status: "awaiting-approval", pending: { kind: "start" } })).toEqual({
      approve: true,
      continue: false,
      stop: true,
    });
    expect(offers({ status: "paused", pending: path })).toEqual({
      approve: true,
      continue: false,
      stop: true,
    });
  });

  test("a pause with nothing pending, or an interrupted task: Continue, and Stop", () => {
    for (const status of ["paused", "interrupted"] as const) {
      expect(offers({ status })).toEqual({ approve: false, continue: true, stop: true });
    }
  });

  test("a task that ended: nothing", () => {
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      expect(offers({ status, pending: path })).toEqual({
        approve: false,
        continue: false,
        stop: false,
      });
    }
  });

  test("with Assistant Mode off or not ready, only a Deny at the start goes through", () => {
    for (const answer of ["once", "always", "deny"] as const) {
      expect(modeRefuses("path", answer, { enabled: true, ready: true })).toBe(false);
      expect(modeRefuses("start", answer, undefined)).toBe(false);
    }
    for (const assistant of [
      { enabled: false, ready: true },
      { enabled: true, ready: false },
    ]) {
      expect(modeRefuses("start", "deny", assistant)).toBe(false);
      expect(modeRefuses("start", "once", assistant)).toBe(true);
      expect(modeRefuses("start", "always", assistant)).toBe(true);
      expect(modeRefuses("path", "deny", assistant)).toBe(true);
      expect(modeRefuses("fetch", "once", assistant)).toBe(true);
    }
  });

  test("the pause prompt says why it paused, and leaves an approval to its own", () => {
    expect(pauseKind({ status: "paused", pause: { reason: "spend", detail: "" } })).toBe("spend");
    expect(pauseKind({ status: "paused", pause: { reason: "unpriced", detail: "" } })).toBe(
      "unpriced",
    );
    expect(pauseKind({ status: "interrupted" })).toBe("interrupted");
    expect(pauseKind({ status: "paused" })).toBe("approval");
    expect(
      pauseKind({ status: "paused", pending: path, pause: { reason: "approval", detail: "" } }),
    ).toBeNull();
    expect(pauseKind({ status: "running", pause: { reason: "spend", detail: "" } })).toBeNull();
  });
});

describe("the lines she passed on, which the card lists", () => {
  const inbox = {
    steer: [
      `${STEER_PREFIX}页面标题写成『今天的事』`,
      // The manager's own answer lines share the inbox.
      "The owner allowed read access to /x/notes.txt. Try again.",
      `${STEER_PREFIX}**加粗**和 <b>标签</b>照原样`,
      `${STEER_PREFIX}页面标题写成『今天的事』`,
    ],
    followUp: [],
  };

  test("while it waits on the owner: hers alone, her prefix off, as she wrote them", () => {
    for (const status of ["awaiting-approval", "paused", "interrupted"] as const) {
      expect(queuedLines(task("1", status, { inbox }))).toEqual([
        "页面标题写成『今天的事』",
        "**加粗**和 <b>标签</b>照原样",
        "页面标题写成『今天的事』",
      ]);
    }
  });

  test("none while it runs or once it has ended, nor while none of hers waits", () => {
    // A running task reads them before its next request, and an ended one dropped them.
    for (const status of ["running", "succeeded", "failed", "cancelled"] as const) {
      expect(queuedLines(task("1", status, { inbox }))).toEqual([]);
    }
    expect(queuedLines(task("1", "paused"))).toEqual([]);
    const answered = { steer: ["The owner refused access to /x/notes.txt."], followUp: [] };
    expect(queuedLines(task("1", "paused", { inbox: answered }))).toEqual([]);
  });
});

describe("the Tasks list", () => {
  test("the live tasks come first, then the ended ones, each newest first", () => {
    const tasks = [
      task("7", "succeeded"),
      task("6", "running"),
      task("5", "failed"),
      task("4", "awaiting-approval"),
      task("3", "cancelled"),
      task("2", "interrupted"),
      task("1", "paused"),
      task("8", "paused"),
    ];
    expect(listOrder(tasks).map((entry) => entry.id)).toEqual([
      "8",
      "6",
      "4",
      "2",
      "1",
      "7",
      "5",
      "3",
    ]);
  });

  test("counts the tasks waiting on the owner", () => {
    const tasks = STATUSES.map((status, i) => task(String(i + 1), status));
    expect(waitingCount(tasks)).toBe(3);
    expect(waitingCount([])).toBe(0);
  });
});

describe("the waiting bar", () => {
  test("asks about the oldest task waiting, and says how many more wait", () => {
    const tasks = [
      task("4", "paused", { pending: path }),
      task("3", "running"),
      task("2", "awaiting-approval", { pending: { kind: "start" } }),
      task("1", "succeeded"),
    ];
    expect(barChoice(tasks)).toEqual({ task: tasks[2], others: 1 });
  });

  test("shows nothing while no task waits", () => {
    expect(barChoice([task("1", "running"), task("2", "failed")])).toBeNull();
    expect(barChoice([])).toBeNull();
  });
});

describe("polling", () => {
  test("often while a task runs, less while one waits, and the idle rate otherwise", () => {
    expect(tasksPoll([task("1", "succeeded"), task("2", "running")], false)).toBe(RUNNING_POLL_MS);
    expect(tasksPoll([task("1", "paused")], false)).toBe(WAITING_POLL_MS);
    expect(tasksPoll([task("1", "interrupted")], 30_000)).toBe(WAITING_POLL_MS);
    expect(tasksPoll([task("1", "cancelled")], false)).toBe(false);
    expect(tasksPoll([], 30_000)).toBe(30_000);
    expect(tasksPoll(undefined, false)).toBe(false);
  });

  test("a task that was live and has ended is noticed once", () => {
    const before = new Map<string, TaskStatus>([
      ["1", "running"],
      ["2", "paused"],
      ["3", "succeeded"],
    ]);
    const after = [
      task("1", "succeeded"),
      task("2", "paused"),
      task("3", "succeeded"),
      // New to the page, and already over: no end was seen.
      task("4", "failed"),
    ];
    expect(endedSince(before, after)).toEqual(["1"]);
  });
});

describe("the next spend pause", () => {
  test("is the next multiple of the step above what it spent", () => {
    expect(nextPauseAt(0, 1)).toBe(1);
    expect(nextPauseAt(0.42, 1)).toBe(1);
    // Paused at its first step, it pauses again at the second.
    expect(nextPauseAt(1.02, 1)).toBe(2);
    expect(nextPauseAt(1, 1)).toBe(2);
    expect(nextPauseAt(0.3, 0.25)).toBe(0.5);
  });

  test("is none while the pauses are off", () => {
    expect(nextPauseAt(5, 0)).toBeNull();
  });
});

test("a file in the task's folder shows from there, any other in full", () => {
  expect(pathIn("/Users/me/todo", "/Users/me/todo/index.html")).toBe("index.html");
  expect(pathIn("/Users/me/todo/", "/Users/me/todo/src/a.ts")).toBe("src/a.ts");
  expect(pathIn("/Users/me/todo", "/Users/me/todo-2/a.ts")).toBe("/Users/me/todo-2/a.ts");
  expect(pathIn("/Users/me/todo", "/Users/me/todo")).toBe("/Users/me/todo");
  expect(pathIn("C:\\work", "C:\\work\\a.txt")).toBe("a.txt");
});

describe("the cards that follow their steps", () => {
  const following = (tasks: readonly TaskSnapshot[], open: boolean) =>
    tasks.filter((entry) => followsSteps(entry.id, tasks, open)).map((entry) => entry.id);

  test("of six running tasks with their steps closed, only the newest's card holds a stream", () => {
    // A follow holds one of the browser's six connections to the server while its task runs: six
    // would leave none for the chat's own requests, Stop's included.
    const tasks = ["1", "2", "3", "4", "5", "6"].map((id) => task(id, "running"));
    expect(following(tasks, false)).toEqual(["6"]);
  });

  test("a card whose steps are open follows, running or not", () => {
    const tasks = [task("1", "running"), task("2", "running"), task("3", "succeeded")];
    expect(following(tasks, true)).toEqual(["1", "2", "3"]);
  });

  test("none follows while no task runs and no steps are open", () => {
    const tasks = [task("1", "paused"), task("2", "awaiting-approval"), task("3", "succeeded")];
    expect(following(tasks, false)).toEqual([]);
  });
});

describe("the steps a card opens", () => {
  const shown = (
    display: ChatDisplay,
    more: Partial<Parameters<typeof stepsShown>[0]> = {},
  ): boolean => stepsShown({ display, chosen: null, newest: false, shownLive: false, ...more });

  test("in verbose, the newest running task's card opens its steps, and no other", () => {
    const tasks = [task("1", "running"), task("2", "running"), task("3", "paused")];
    const opened = tasks.filter((entry) =>
      shown("verbose", { newest: followsSteps(entry.id, tasks, false) }),
    );
    expect(opened.map((entry) => entry.id)).toEqual(["2"]);
  });

  test("in normal and focus, only the owner's own choice opens them", () => {
    for (const display of ["normal", "focus"] as const) {
      expect(shown(display, { newest: true, shownLive: true })).toBe(false);
      expect(shown(display, { chosen: true })).toBe(true);
    }
  });

  test("the owner's choice wins over verbose's, either way", () => {
    expect(shown("verbose", { newest: true, chosen: false })).toBe(false);
    expect(shown("verbose", { chosen: true })).toBe(true);
  });

  test("steps shown live stay once the task pauses or ends, until another running task is newest", () => {
    const step = (before: boolean, newest: boolean, running: boolean) =>
      keepsLiveSteps(before, { display: "verbose", newest, running });
    const watched = step(false, true, true);
    expect(watched).toBe(true);
    const paused = step(watched, false, false);
    expect(shown("verbose", { shownLive: paused })).toBe(true);
    const ended = step(paused, false, false);
    expect(shown("verbose", { shownLive: ended })).toBe(true);
    // Another task runs as the newest while this one still runs: this card lets go of its stream.
    expect(step(watched, false, true)).toBe(false);
  });

  test("a card read afresh, its task waiting, running behind a newer one, or ended, keeps Show Steps", () => {
    for (const running of [false, true]) {
      expect(keepsLiveSteps(false, { display: "verbose", newest: false, running })).toBe(false);
    }
    expect(shown("verbose")).toBe(false);
  });

  test("leaving verbose drops the steps shown live", () => {
    expect(keepsLiveSteps(true, { display: "normal", newest: true, running: true })).toBe(false);
    expect(keepsLiveSteps(true, { display: "focus", newest: false, running: false })).toBe(false);
    expect(keepsLiveSteps(true, { display: null, newest: false, running: false })).toBe(false);
  });
});

describe("/stop's choice", () => {
  test("is every task that hasn't ended, newest first", () => {
    const tasks = [
      task("1", "running"),
      task("2", "succeeded"),
      task("3", "awaiting-approval"),
      task("4", "paused"),
      task("5", "cancelled"),
      task("6", "interrupted"),
      task("7", "failed"),
    ];
    expect(stopChoice(tasks).map((entry) => entry.id)).toEqual(["6", "4", "3", "1"]);
  });

  test("is the one task the chat has live, or none", () => {
    expect(stopChoice([task("1", "running")]).map((entry) => entry.id)).toEqual(["1"]);
    expect(stopChoice([task("1", "succeeded"), task("2", "failed")])).toEqual([]);
    expect(stopChoice([])).toEqual([]);
  });
});
