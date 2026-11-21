// Which page the window shows as the backend's state and the window's own failures move it, what
// the failure page says, and what Try Again does.
import { describe, expect, test } from "vitest";
import { BearerToken } from "../src/main/attach.ts";
import type { BackendFailure, BackendState } from "../src/main/controller.ts";
import {
  type Failure,
  failurePage,
  shellPageStrings,
  type WindowPage,
  WindowPages,
} from "../src/main/pages.ts";
import { STRINGS } from "../src/main/strings.ts";

const en = STRINGS.en;
const zh = STRINGS["zh-Hans"];

const STARTING: BackendState = { phase: "starting" };
const READY: BackendState = {
  phase: "ready",
  origin: "http://127.0.0.1:7860",
  token: new BearerToken("t".repeat(43)),
  owned: true,
};
const HOLDING: BackendState = { phase: "holding", owned: true };
const EXITED: BackendFailure = { reason: "exited", code: 1, signal: null, stderr: ["boom"] };
const FAILED: BackendState = { phase: "failed", failure: EXITED };

function pages(): { pages: WindowPages; loads: (WindowPage | "reload")[] } {
  const loads: (WindowPage | "reload")[] = [];
  return {
    loads,
    pages: new WindowPages({
      load: (page) => loads.push(page),
      reloadApp: () => loads.push("reload"),
    }),
  };
}

describe("the window's page", () => {
  test("starts on the loading page, and shows the app once the backend is ready", () => {
    const { pages: window, loads } = pages();
    window.opened(STARTING);
    window.backend(STARTING);
    window.backend(READY);
    expect(loads).toEqual(["loading", "app"]);
    expect(window.page).toBe("app");
  });

  test("leaves the app as it is through a restart or a grace period", () => {
    const { pages: window, loads } = pages();
    window.opened(READY);
    window.backend(HOLDING);
    window.backend(READY);
    window.backend(STARTING);
    window.backend(READY);
    expect(loads).toEqual(["app"]);
  });

  test("reloads the app once the backend answers after the waiting page stood in for it", () => {
    const { pages: window, loads } = pages();
    window.opened(READY);
    window.backend(HOLDING);
    window.waited();
    window.backend(READY);
    window.backend(HOLDING);
    window.backend(READY);
    expect(loads).toEqual(["app", "reload"]);
  });

  test("a new window opens on the page the backend's state calls for", () => {
    for (const [state, page] of [
      [STARTING, "loading"],
      [HOLDING, "loading"],
      [READY, "app"],
      [FAILED, "failed"],
    ] as const) {
      const { pages: window, loads } = pages();
      window.opened(state);
      expect([state.phase, loads]).toEqual([state.phase, [page]]);
    }
  });

  test("a window made again starts afresh, but for the backend's failure", () => {
    const { pages: window, loads } = pages();
    window.opened(READY);
    window.window("the page's renderer is gone (crashed)");
    window.opened(READY);
    expect(loads).toEqual(["app", "failed", "app"]);
    expect(window.failure).toBeNull();
    window.backend(FAILED);
    window.opened(FAILED);
    expect(loads.slice(-2)).toEqual(["failed", "failed"]);
    expect(window.failure).toEqual({ kind: "backend", failure: EXITED });
  });
});

describe("failures", () => {
  test("the backend's shows the failure page, from the loading page or the app", () => {
    for (const first of [STARTING, READY]) {
      const { pages: window, loads } = pages();
      window.opened(first);
      window.backend(FAILED);
      expect(loads.at(-1)).toBe("failed");
      expect(window.failure).toEqual({ kind: "backend", failure: EXITED });
    }
  });

  test("the window's own, but never the failure page's, which would load it again and again", () => {
    const { pages: window, loads } = pages();
    window.opened(READY);
    window.window("ERR_FAILED (-2) loading eidolon-app://app/");
    window.window("the preload failed: x");
    expect(loads).toEqual(["app", "failed"]);
    expect(window.failure).toEqual({
      kind: "window",
      detail: "ERR_FAILED (-2) loading eidolon-app://app/",
    });
  });

  test("a window failure waits for Try Again whatever the backend does", () => {
    const { pages: window, loads } = pages();
    window.opened(READY);
    window.window("the page's renderer is gone (oom)");
    window.backend(HOLDING);
    window.backend(READY);
    expect(loads).toEqual(["app", "failed"]);
  });
});

describe("Try Again", () => {
  test("after the backend failed: the loading page, and the backend starts again", () => {
    const { pages: window, loads } = pages();
    window.opened(STARTING);
    window.backend(FAILED);
    expect(window.retry(FAILED)).toBe(true);
    window.backend(STARTING);
    window.backend(READY);
    expect(loads).toEqual(["loading", "failed", "loading", "app"]);
    expect(window.failure).toBeNull();
  });

  test("after the window failed: the app again while the backend is ready, without a new backend", () => {
    const { pages: window, loads } = pages();
    window.opened(READY);
    window.window("the preload failed: x");
    expect(window.retry(READY)).toBe(false);
    expect(loads).toEqual(["app", "failed", "app"]);
  });

  test("after the window failed during a restart: the loading page until the backend is ready", () => {
    const { pages: window, loads } = pages();
    window.opened(READY);
    window.window("the page's renderer is gone (crashed)");
    expect(window.retry(HOLDING)).toBe(false);
    window.backend(READY);
    expect(loads).toEqual(["app", "failed", "loading", "app"]);
  });

  test("does nothing unless the failure page shows", () => {
    const { pages: window, loads } = pages();
    window.opened(READY);
    expect(window.retry(FAILED)).toBe(false);
    expect(loads).toEqual(["app"]);
  });
});

describe("the failure page's words", () => {
  const backend = (failure: BackendFailure): Failure => ({ kind: "backend", failure });

  test("a backend that ended: its stderr's tail, then why, in a line", () => {
    expect(failurePage(backend(EXITED), en)).toEqual({
      title: "Eidolon's server stopped",
      message: "Try again. If it happens again, Show Logs has the details.",
      stderr: "boom\nThe server exited with code 1.",
    });
    const killed = { reason: "exited", code: null, signal: "SIGKILL", stderr: [] } as const;
    expect(failurePage(backend(killed), en).stderr).toBe("The server stopped on SIGKILL.");
    for (const [failure, line] of [
      [{ reason: "no-listening", stderr: [] }, "The server didn't start listening within 60 s."],
      [
        { reason: "token", stderr: [] },
        "The server listened, but left no local-token to reach it with.",
      ],
      [{ reason: "unanswered", stderr: [] }, "The server stopped answering for 60 s."],
      [
        { reason: "error", message: "spawn EACCES", stderr: [] },
        "The server couldn't be started: spawn EACCES",
      ],
    ] as const) {
      expect(failurePage(backend(failure), en).stderr).toBe(line);
    }
  });

  test("another Eidolon on the data home: who it is", () => {
    const held: BackendFailure = { reason: "held", holder: { pid: 4821, port: 7861 }, stderr: [] };
    expect(failurePage(backend(held), en)).toEqual({
      title: "Another Eidolon is using this data home",
      message: en.text.heldDetail({ pid: 4821, port: 7861 }),
      stderr: "Another Eidolon holds this data home and didn't answer.",
    });
    expect(failurePage(backend({ reason: "held", stderr: [] }), zh).message).toBe(
      zh.text.heldDetail({ pid: null, port: null }),
    );
  });

  test("the window's own: its own title, and what failed as the details", () => {
    expect(failurePage({ kind: "window", detail: "the preload failed: x" }, zh)).toEqual({
      title: zh.text.windowFailed,
      message: zh.text.failed,
      stderr: "the preload failed: x",
    });
  });
});

test("the shell pages' strings are the table's, in the language given", () => {
  expect(shellPageStrings("en", en)).toEqual({
    lang: "en",
    starting: "Starting Eidolon…",
    waiting: "Waiting for Eidolon's server…",
    tryAgain: "Try Again",
    showLogs: "Show Logs",
    quit: "Quit",
    details: "Details",
  });
  expect(shellPageStrings("zh-Hans", zh)).toMatchObject({ lang: "zh-Hans", details: "详情" });
});
