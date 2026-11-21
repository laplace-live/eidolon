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
  checkQuit,
  type QuitCheck,
  QuitConfirmation,
  quitBox,
} from "../src/main/quit-check.ts";
import { STRINGS } from "../src/main/strings.ts";

afterEach(() => {
  vi.useRealTimers();
});

type StatusAnswer = Pick<Status, "activeCalls"> & {
  readonly assistant: Pick<Status["assistant"], "running">;
};

function job(status: JobSnapshot["status"]): Pick<JobSnapshot, "id" | "status"> {
  return { id: `20261121T000000-${status}`, status };
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
    const answer = answers[path];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => answer };
  };
  return { fetch, requests };
}

const status = (activeCalls: number, running: number): StatusAnswer => ({
  activeCalls,
  assistant: { running },
});

describe("checkQuit", () => {
  test("counts the calls, the running tasks and the running jobs, from one request each", async () => {
    const { fetch, requests } = backend({
      "/api/local/status": { ...status(1, 2), version: "0.13.0", restartRequired: false },
      "/api/local/jobs": [job("running"), job("succeeded"), job("interrupted"), job("running")],
    });
    await expect(checkQuit(fetch)).resolves.toEqual({ calls: 1, tasks: 2, jobs: 2 });
    expect(requests.map(({ path }) => path).sort()).toEqual([
      "/api/local/jobs",
      "/api/local/status",
    ]);
    const [first, second] = requests;
    expect(first?.signal).toBe(second?.signal);
  });

  test("finds nothing running on an idle backend", async () => {
    const { fetch } = backend({ "/api/local/status": status(0, 0), "/api/local/jobs": [] });
    await expect(checkQuit(fetch)).resolves.toEqual({ calls: 0, tasks: 0, jobs: 0 });
  });

  test.each<[string, Readonly<Record<string, unknown>>]>([
    ["a refused status", { "/api/local/status": 401, "/api/local/jobs": [] }],
    ["a refused job list", { "/api/local/status": status(0, 0), "/api/local/jobs": 503 }],
    ["a failed request", { "/api/local/status": new Error("ECONNREFUSED"), "/api/local/jobs": [] }],
    [
      "no activeCalls",
      { "/api/local/status": { assistant: { running: 0 } }, "/api/local/jobs": [] },
    ],
    ["no assistant", { "/api/local/status": { activeCalls: 0 }, "/api/local/jobs": [] }],
    ["a count below 0", { "/api/local/status": status(-1, 0), "/api/local/jobs": [] }],
    ["a count that isn't whole", { "/api/local/status": status(0, 0.5), "/api/local/jobs": [] }],
    ["jobs that aren't a list", { "/api/local/status": status(0, 0), "/api/local/jobs": {} }],
    ["a status that isn't an object", { "/api/local/status": null, "/api/local/jobs": [] }],
  ])("is unknown on %s", async (_name, answers) => {
    await expect(checkQuit(backend(answers).fetch)).resolves.toBe("unknown");
  });

  test("is unknown when a body can't be read", async () => {
    const fetch: BackendFetch = async () => ({
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    });
    await expect(checkQuit(fetch)).resolves.toBe("unknown");
  });

  test("gives both requests 2 s in all, then cancels them, even a fetch that ignores its signal", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch: BackendFetch = (path, { signal }) => {
      signals.push(signal);
      return path === "/api/local/status"
        ? Promise.resolve({ ok: true, json: async () => status(0, 0) })
        : new Promise(() => {});
    };
    let settled = false;
    const check = checkQuit(fetch).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(check).resolves.toBe("unknown");
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  });

  test("cancels the other request as soon as one fails", async () => {
    let jobsSignal: AbortSignal | null = null;
    const fetch: BackendFetch = (path, { signal }) => {
      if (path === "/api/local/status") return Promise.reject(new Error("ECONNRESET"));
      jobsSignal = signal;
      return new Promise(() => {});
    };
    await expect(checkQuit(fetch)).resolves.toBe("unknown");
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
      title: "Eidolon",
      message: "Quit Eidolon?",
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
      title: "Eidolon",
      message: "退出 Eidolon？",
      detail: "通话、2 个任务和 1 个作业会在退出时中断。",
      buttons: ["退出", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
  });
});

function setup(check: () => Promise<QuitCheck> | null, platform: NodeJS.Platform = "darwin") {
  const shown: MessageBoxOptions[] = [];
  let response = 0;
  const focus = vi.fn();
  const confirmation = new QuitConfirmation({
    check,
    strings: () => STRINGS.en,
    show: async (options) => {
      shown.push(options);
      return { response };
    },
    focus,
    platform,
  });
  return {
    confirmation,
    shown,
    focus,
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
    const cancel = setup(async () => "unknown" as const);
    cancel.answer(1);
    expect(await cancel.confirmation.confirm()).toBe(false);
    expect(cancel.shown.map((box) => box.detail)).toEqual([STRINGS.en.text.quitUnknown]);
  });

  test("joins an open decision instead of stacking a second box, and checks once per decision", async () => {
    const checked = Promise.withResolvers<QuitCheck>();
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

  test("once disposed, a pending decision answers false without a box, and so does every later one", async () => {
    const checked = Promise.withResolvers<QuitCheck>();
    const f = setup(() => checked.promise);
    const pending = f.confirmation.confirm();
    f.confirmation.dispose();
    checked.resolve({ calls: 0, tasks: 1, jobs: 0 });
    expect(await pending).toBe(false);
    expect(f.shown).toEqual([]);
    expect(await f.confirmation.confirm()).toBe(false);
    expect(f.focus).not.toHaveBeenCalled();
  });

  test("doesn't quit on a box answered after it was disposed", async () => {
    const answered = Promise.withResolvers<{ response: number }>();
    const show = vi.fn(() => answered.promise);
    const confirmation = new QuitConfirmation({
      check: async () => ({ calls: 1, tasks: 0, jobs: 0 }),
      strings: () => STRINGS.en,
      show,
      focus: () => {},
      platform: "darwin",
    });
    const pending = confirmation.confirm();
    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    confirmation.dispose();
    answered.resolve({ response: 0 });
    expect(await pending).toBe(false);
  });

  test("takes the platform's box", async () => {
    const f = setup(async () => ({ calls: 0, tasks: 0, jobs: 1 }), "win32");
    await f.confirmation.confirm();
    expect(f.shown.map((box) => box.type)).toEqual(["none"]);
  });
});
