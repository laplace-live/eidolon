// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/tests/quit-confirmation.spec.ts@2e39e70496
//
// The check against a fake backend's answers, shaped as GET status and GET jobs answer; the box;
// then deepseek's one-decision-at-a-time cases.
import type { MessageBoxOptions } from "electron";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { JobSnapshot, Status } from "../../bot/src/local/api.ts";
import {
  type BackendFetch,
  type BackendResponse,
  checkQuit,
  type QuitCheck,
  QuitConfirmation,
  type QuitPurpose,
  quitBox,
} from "../src/main/quit-check.ts";
import { STRINGS, type Stopping } from "../src/main/strings.ts";

afterEach(() => {
  vi.useRealTimers();
});

const STATUS = "/api/local/status";
const JOBS = "/api/local/jobs";

type StatusAnswer = Pick<Status, "activeCalls"> & {
  readonly assistant: Pick<Status["assistant"], "running">;
};

function job(status: JobSnapshot["status"]): Pick<JobSnapshot, "id" | "status"> {
  return { id: `20261121T000000-${status}`, status };
}

const status = (activeCalls: number, running: number): StatusAnswer => ({
  activeCalls,
  assistant: { running },
});

function answer(body: unknown): BackendResponse {
  return { ok: true, status: 200, json: async () => body };
}

interface Requested {
  readonly path: string;
  readonly signal: AbortSignal;
}

/** A backend that answers each path from `answers`: a body, a refusal's status, or a failure. */
function backend(answers: Readonly<Record<string, unknown>>): {
  readonly fetch: BackendFetch;
  readonly requests: Requested[];
} {
  const requests: Requested[] = [];
  const fetch: BackendFetch = async (path, { signal }) => {
    requests.push({ path, signal });
    const body = answers[path];
    if (body instanceof Error) throw body;
    if (typeof body === "number") return { ok: false, status: body, json: async () => ({}) };
    return answer(body);
  };
  return { fetch, requests };
}

/** What a quit over `checkQuit(fetch)` logs, having asked as when the backend can't say. */
async function logged(fetch: BackendFetch): Promise<string[]> {
  const warn = vi.fn<(message: string) => void>();
  const shown: MessageBoxOptions[] = [];
  const confirmation = new QuitConfirmation({
    check: () => checkQuit(fetch),
    unsaved: () => false,
    strings: () => STRINGS.en,
    show: async (box) => {
      shown.push(box);
      return { response: 1 };
    },
    focus: () => {},
    log: { warn },
    platform: "darwin",
  });
  expect(await confirmation.confirm()).toBe(false);
  expect(shown.map((box) => box.detail)).toEqual([STRINGS.en.text.quitUnknown]);
  return warn.mock.calls.map(([message]) => message);
}

const WHY = "Eidolon: couldn't check what quitting stops:";

describe("checkQuit", () => {
  test("counts the calls, the running tasks and the running jobs, from one request each", async () => {
    const { fetch, requests } = backend({
      [STATUS]: { ...status(1, 2), version: "0.13.0", restartRequired: false },
      [JOBS]: [job("running"), job("succeeded"), job("interrupted"), job("running")],
    });
    await expect(checkQuit(fetch)).resolves.toEqual({ calls: 1, tasks: 2, jobs: 2 });
    expect(requests.map(({ path }) => path).sort()).toEqual([JOBS, STATUS]);
    const [first, second] = requests;
    expect(first?.signal).toBe(second?.signal);
  });

  test("finds nothing running on an idle backend", async () => {
    const { fetch } = backend({ [STATUS]: status(0, 0), [JOBS]: [] });
    await expect(checkQuit(fetch)).resolves.toEqual({ calls: 0, tasks: 0, jobs: 0 });
  });

  const noCounts = `GET ${STATUS}: no counts in activeCalls and assistant.running`;
  test.each<[string, Readonly<Record<string, unknown>>, string]>([
    ["a refused status", { [STATUS]: 401, [JOBS]: [] }, `GET ${STATUS}: answered 401`],
    ["a refused job list", { [STATUS]: status(0, 0), [JOBS]: 503 }, `GET ${JOBS}: answered 503`],
    [
      "a failed request",
      {
        [STATUS]: new TypeError("fetch failed", {
          cause: new Error("connect ECONNREFUSED 127.0.0.1:7860"),
        }),
        [JOBS]: [],
      },
      `GET ${STATUS}: fetch failed: connect ECONNREFUSED 127.0.0.1:7860`,
    ],
    ["no activeCalls", { [STATUS]: { assistant: { running: 0 } }, [JOBS]: [] }, noCounts],
    ["no assistant", { [STATUS]: { activeCalls: 0 }, [JOBS]: [] }, noCounts],
    ["a count below 0", { [STATUS]: status(-1, 0), [JOBS]: [] }, noCounts],
    ["a count that isn't whole", { [STATUS]: status(0, 0.5), [JOBS]: [] }, noCounts],
    ["jobs that aren't a list", { [STATUS]: status(0, 0), [JOBS]: {} }, `GET ${JOBS}: no list`],
    ["a status that isn't an object", { [STATUS]: null, [JOBS]: [] }, noCounts],
  ])("fails on %s, and the quit asks and logs why", async (_name, answers, why) => {
    await expect(checkQuit(backend(answers).fetch)).rejects.toThrow();
    await expect(logged(backend(answers).fetch)).resolves.toEqual([`${WHY} ${why}`]);
  });

  test("fails when a body can't be read", async () => {
    const fetch: BackendFetch = async (path) =>
      path === STATUS
        ? {
            ok: true,
            status: 200,
            json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
          }
        : answer([]);
    await expect(logged(fetch)).resolves.toEqual([
      `${WHY} GET ${STATUS}: Unexpected end of JSON input`,
    ]);
  });

  /** The check's outcome so far: null until it settles, then its counts or its error's message. */
  function watch(check: Promise<Stopping>): { readonly settled: () => unknown } {
    let settled: unknown = null;
    check.then(
      (stopping) => {
        settled = stopping;
      },
      (error: Error) => {
        settled = error.message;
      },
    );
    return { settled: () => settled };
  }

  test("gives both requests 2 s in all, then cancels them, even a fetch that ignores its signal", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch: BackendFetch = (path, { signal }) => {
      signals.push(signal);
      return path === STATUS ? Promise.resolve(answer(status(0, 0))) : new Promise(() => {});
    };
    const check = watch(checkQuit(fetch));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(check.settled()).toBeNull();
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1);
    expect(check.settled()).toBe("no answer in 2 s");
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  test("counts the bodies in those 2 s: a body that never ends is as late as no answer", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch: BackendFetch = async (path, { signal }) => {
      signals.push(signal);
      return path === STATUS
        ? { ok: true, status: 200, json: () => new Promise(() => {}) }
        : answer([]);
    };
    const check = watch(checkQuit(fetch));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(check.settled()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(check.settled()).toBe("no answer in 2 s");
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  test("cancels the other request as soon as one fails", async () => {
    let jobsSignal: AbortSignal | null = null;
    const fetch: BackendFetch = (path, { signal }) => {
      if (path === STATUS) return Promise.reject(new Error("ECONNRESET"));
      jobsSignal = signal;
      return new Promise(() => {});
    };
    await expect(checkQuit(fetch)).rejects.toThrow(`GET ${STATUS}`);
    expect((jobsSignal as AbortSignal | null)?.aborted).toBe(true);
  });
});

describe("quitBox", () => {
  const en = STRINGS.en;

  test("asks nothing when nothing runs", () => {
    expect(quitBox({ calls: 0, tasks: 0, jobs: 0 }, en, "darwin")).toBeNull();
  });

  test("names what stops", () => {
    const detail = (check: QuitCheck) => quitBox(check, en, "darwin")?.detail;
    expect(detail({ calls: 1, tasks: 0, jobs: 0 })).toBe("Quitting stops the call.");
    expect(detail({ calls: 0, tasks: 1, jobs: 0 })).toBe("Quitting stops a task.");
    expect(detail({ calls: 0, tasks: 0, jobs: 3 })).toBe("Quitting stops 3 jobs.");
    expect(detail({ calls: 2, tasks: 1, jobs: 0 })).toBe("Quitting stops 2 calls and a task.");
    expect(detail({ calls: 1, tasks: 2, jobs: 1 })).toBe(
      "Quitting stops the call, 2 tasks and a job.",
    );
    expect(detail("unknown")).toBe(en.text.quitUnknown);
  });

  test("on macOS, a warning whose default is Quit, with Cancel on Esc", () => {
    expect(quitBox({ calls: 0, tasks: 1, jobs: 0 }, en, "darwin")).toEqual({
      type: "warning",
      title: "LAPLACE Eidolon",
      message: "Quit LAPLACE Eidolon?",
      detail: "Quitting stops a task.",
      buttons: ["Quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
  });

  test("on Windows, a plain task dialog, in the shell's language", () => {
    expect(quitBox({ calls: 1, tasks: 2, jobs: 1 }, STRINGS["zh-Hans"], "win32")).toEqual({
      type: "none",
      title: "LAPLACE Eidolon",
      message: "退出 LAPLACE Eidolon？",
      detail: "通话、2 个任务和 1 个作业会在退出时中断。",
      buttons: ["退出", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
  });

  test("before the restart that installs an update, names what a restart stops, Restart the default", () => {
    expect(quitBox({ calls: 0, tasks: 0, jobs: 0 }, en, "darwin", "restart")).toBeNull();
    expect(quitBox({ calls: 1, tasks: 0, jobs: 2 }, en, "darwin", "restart")).toEqual({
      type: "warning",
      title: "LAPLACE Eidolon",
      message: "Restart LAPLACE Eidolon?",
      detail: "Restarting stops the call and 2 jobs.",
      buttons: ["Restart", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    expect(quitBox("unknown", en, "darwin", "restart")?.detail).toBe(en.text.restartUnknown);
    expect(
      quitBox({ calls: 0, tasks: 1, jobs: 1 }, STRINGS["zh-Hans"], "win32", "restart"),
    ).toEqual(
      expect.objectContaining({
        message: "重启 LAPLACE Eidolon？",
        detail: "1 个任务和 1 个作业会在重启时中断。",
        buttons: ["重启", "取消"],
      }),
    );
  });

  const LOST = "Your unsaved changes will be lost.";

  test("asks nothing with no backend of ours ready and no unsaved edits", () => {
    expect(quitBox(null, en, "darwin")).toBeNull();
    expect(quitBox(null, en, "darwin", "restart")).toBeNull();
    expect(quitBox(null, en, "darwin", "quit", false)).toBeNull();
  });

  test("asks over unsaved edits alone, with no backend of ours ready or nothing running", () => {
    for (const check of [null, { calls: 0, tasks: 0, jobs: 0 }]) {
      expect(quitBox(check, en, "darwin", "quit", true)).toEqual({
        type: "warning",
        title: "LAPLACE Eidolon",
        message: "Quit LAPLACE Eidolon?",
        detail: LOST,
        buttons: ["Quit", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      expect(quitBox(check, en, "darwin", "restart", true)).toEqual(
        expect.objectContaining({
          message: "Restart LAPLACE Eidolon?",
          detail: LOST,
          buttons: ["Restart", "Cancel"],
        }),
      );
    }
  });

  test("names unsaved edits after what else a quit or a restart stops, or after its unknown", () => {
    const detail = (check: QuitCheck, purpose: QuitPurpose) =>
      quitBox(check, en, "darwin", purpose, true)?.detail;
    expect(detail({ calls: 1, tasks: 0, jobs: 2 }, "quit")).toBe(
      `Quitting stops the call and 2 jobs. ${LOST}`,
    );
    expect(detail({ calls: 0, tasks: 1, jobs: 0 }, "restart")).toBe(
      `Restarting stops a task. ${LOST}`,
    );
    expect(detail("unknown", "quit")).toBe(`${en.text.quitUnknown} ${LOST}`);
    expect(detail("unknown", "restart")).toBe(`${en.text.restartUnknown} ${LOST}`);
  });

  test("in the shell's language, on Windows' plain task dialog", () => {
    const zh = STRINGS["zh-Hans"];
    expect(quitBox({ calls: 1, tasks: 0, jobs: 0 }, zh, "win32", "quit", true)).toEqual({
      type: "none",
      title: "LAPLACE Eidolon",
      message: "退出 LAPLACE Eidolon？",
      detail: "通话会在退出时中断。未保存的修改将会丢失。",
      buttons: ["退出", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    expect(quitBox(null, zh, "win32", "restart", true)).toEqual(
      expect.objectContaining({
        message: "重启 LAPLACE Eidolon？",
        detail: "未保存的修改将会丢失。",
        buttons: ["重启", "取消"],
      }),
    );
  });
});

function setup(
  check: () => Promise<Stopping> | null,
  platform: NodeJS.Platform = "darwin",
  unsaved: () => boolean = () => false,
) {
  const shown: MessageBoxOptions[] = [];
  let response = 0;
  const focus = vi.fn();
  const warn = vi.fn<(message: string) => void>();
  const confirmation = new QuitConfirmation({
    check,
    unsaved,
    strings: () => STRINGS.en,
    show: async (options) => {
      shown.push(options);
      return { response };
    },
    focus,
    log: { warn },
    platform,
  });
  return {
    confirmation,
    shown,
    focus,
    warn,
    answer: (value: number) => {
      response = value;
    },
  };
}

describe("QuitConfirmation", () => {
  test("quits unasked when nothing runs, and when no backend of ours is ready", async () => {
    const idle = setup(async () => ({ calls: 0, tasks: 0, jobs: 0 }));
    expect(await idle.confirmation.confirm()).toBe(true);
    const starting = setup(() => null);
    expect(await starting.confirmation.confirm()).toBe(true);
    expect([...idle.shown, ...starting.shown]).toEqual([]);
  });

  test("quits on Quit and stays on Cancel", async () => {
    const quit = setup(async () => ({ calls: 1, tasks: 0, jobs: 0 }));
    expect(await quit.confirmation.confirm()).toBe(true);
    expect(quit.shown.map((box) => box.detail)).toEqual(["Quitting stops the call."]);
    const cancel = setup(async () => ({ calls: 0, tasks: 0, jobs: 2 }));
    cancel.answer(1);
    expect(await cancel.confirmation.confirm()).toBe(false);
    expect(cancel.shown.map((box) => box.detail)).toEqual(["Quitting stops 2 jobs."]);
    expect([...quit.warn.mock.calls, ...cancel.warn.mock.calls]).toEqual([]);
  });

  test("asks as when the backend can't say when the check fails, and logs why", async () => {
    const f = setup(() => Promise.reject(new Error("no answer in 2 s")));
    expect(await f.confirmation.confirm()).toBe(true);
    expect(f.shown.map((box) => box.detail)).toEqual([STRINGS.en.text.quitUnknown]);
    expect(f.warn.mock.calls).toEqual([[`${WHY} no answer in 2 s`]]);
  });

  test("joins an open decision instead of stacking a second box, and checks once per decision", async () => {
    const checked = Promise.withResolvers<Stopping>();
    const check = vi.fn(() => checked.promise);
    const f = setup(check);
    const first = f.confirmation.confirm();
    const second = f.confirmation.confirm();
    expect(second).toBe(first);
    expect(f.focus).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
    checked.resolve({ calls: 0, tasks: 1, jobs: 0 });
    expect(await first).toBe(true);
    expect(f.shown).toHaveLength(1);
    // The decision is closed: the next request checks afresh.
    expect(f.confirmation.confirm()).not.toBe(first);
    expect(check).toHaveBeenCalledTimes(2);
  });

  test("takes the platform's box", async () => {
    const f = setup(async () => ({ calls: 0, tasks: 0, jobs: 1 }), "win32");
    await f.confirmation.confirm();
    expect(f.shown.map((box) => box.type)).toEqual(["none"]);
  });

  test("asks before a restart in the restart's words, and a quit asked meanwhile joins that box", async () => {
    const checked = Promise.withResolvers<Stopping>();
    const f = setup(() => checked.promise);
    const restart = f.confirmation.confirm("restart");
    expect(f.confirmation.confirm("quit")).toBe(restart);
    checked.resolve({ calls: 1, tasks: 0, jobs: 0 });
    expect(await restart).toBe(true);
    expect(f.shown.map((box) => [box.message, box.detail])).toEqual([
      ["Restart LAPLACE Eidolon?", "Restarting stops the call."],
    ]);
  });

  test("asks over unsaved edits while no backend of ours is ready or the server is attached, a quit and a restart alike", async () => {
    const f = setup(
      () => null,
      "darwin",
      () => true,
    );
    expect(await f.confirmation.confirm()).toBe(true);
    f.answer(1);
    expect(await f.confirmation.confirm("restart")).toBe(false);
    expect(f.shown.map((box) => [box.message, box.detail])).toEqual([
      ["Quit LAPLACE Eidolon?", "Your unsaved changes will be lost."],
      ["Restart LAPLACE Eidolon?", "Your unsaved changes will be lost."],
    ]);
    expect(f.warn.mock.calls).toEqual([]);
  });

  test("names unsaved edits beside what else stops, as the page tells of them once the check answers", async () => {
    const checked = Promise.withResolvers<Stopping>();
    let unsaved = false;
    const f = setup(
      () => checked.promise,
      "darwin",
      () => unsaved,
    );
    const quit = f.confirmation.confirm();
    unsaved = true;
    checked.resolve({ calls: 1, tasks: 0, jobs: 0 });
    expect(await quit).toBe(true);
    const idle = setup(
      async () => ({ calls: 0, tasks: 0, jobs: 0 }),
      "darwin",
      () => true,
    );
    expect(await idle.confirmation.confirm()).toBe(true);
    expect([...f.shown, ...idle.shown].map((box) => box.detail)).toEqual([
      "Quitting stops the call. Your unsaved changes will be lost.",
      "Your unsaved changes will be lost.",
    ]);
  });

  test("asks as when the backend can't say, unsaved edits named after it, when the check fails", async () => {
    const f = setup(
      () => Promise.reject(new Error("no answer in 2 s")),
      "darwin",
      () => true,
    );
    f.answer(1);
    expect(await f.confirmation.confirm()).toBe(false);
    expect(f.shown.map((box) => box.detail)).toEqual([
      `${STRINGS.en.text.quitUnknown} Your unsaved changes will be lost.`,
    ]);
    expect(f.warn.mock.calls).toEqual([[`${WHY} no answer in 2 s`]]);
  });
});
