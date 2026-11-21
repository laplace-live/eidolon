// Which page the window shows as the backend's state and the window's own failures move it, what
// the failure page says, and what Try Again does.
import { describe, expect, test } from "vitest";
import { BearerToken } from "../src/main/attach.ts";
import type { BackendFailure, BackendState } from "../src/main/controller.ts";
import {
  type Failure,
  failurePage,
  PageCommands,
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
  pid: 4242,
};
const HOLDING: BackendState = { phase: "holding", owned: true };
/** A terminal's server on the data home, which the app attached to. */
const ATTACHED: BackendState = {
  phase: "ready",
  origin: "http://127.0.0.1:7861",
  token: new BearerToken("t".repeat(43)),
  owned: false,
  pid: 5151,
};
const HOLDING_ATTACHED: BackendState = { phase: "holding", owned: false };
const EXITED: BackendFailure = { reason: "exited", code: 1, signal: null, stderr: ["boom"] };
const FAILED: BackendState = { phase: "failed", failure: EXITED };

function pages(): {
  pages: WindowPages;
  loads: (WindowPage | "reload")[];
  /** The version of the server the window follows, as the backend last read it. */
  server: { version: string };
} {
  const loads: (WindowPage | "reload")[] = [];
  const server = { version: "0.13.0" };
  return {
    loads,
    server,
    pages: new WindowPages({
      load: (page) => loads.push(page),
      reloadApp: () => loads.push("reload"),
      serverVersion: () => server.version,
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

  test("reloads the app when the server ready next runs another version, so its UI matches the API", () => {
    const { pages: window, loads, server } = pages();
    window.opened(ATTACHED);
    // The terminal's server stops, and after the grace the app's own starts, at its own version.
    window.backend(HOLDING_ATTACHED);
    window.backend(STARTING);
    server.version = "0.14.0";
    window.backend(READY);
    expect(loads).toEqual(["app", "reload"]);
    // The page is that version's now: a restart onto it keeps the page.
    window.backend(HOLDING);
    window.backend(READY);
    expect(loads).toEqual(["app", "reload"]);
  });

  test("keeps the app when the server ready next runs the same version, as a restart's page recovers", () => {
    const { pages: window, loads } = pages();
    window.opened(ATTACHED);
    window.backend(HOLDING_ATTACHED);
    window.backend(STARTING);
    window.backend(READY);
    expect(loads).toEqual(["app"]);
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

  test("a main frame that landed off eidolon-app:// gets main's page again, whichever it was", () => {
    const { pages: window, loads } = pages();
    window.strayed();
    window.opened(STARTING);
    window.strayed();
    window.backend(READY);
    window.strayed();
    window.backend(FAILED);
    window.strayed();
    expect(loads).toEqual(["loading", "loading", "app", "app", "failed", "failed"]);
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

  test("a backend that ended: why, in the page's language, and its stderr as it wrote it", () => {
    expect(failurePage(backend(EXITED), en)).toEqual({
      title: "Eidolon's server stopped",
      message: "It exited with code 1.\nTry again. If it happens again, Show Logs has the details.",
      stderr: "boom",
    });
    expect(failurePage(backend(EXITED), zh)).toEqual({
      title: "Eidolon 的服务器停止了",
      message: "它退出了，退出码为 1。\n请重试。如果再次出现，详情请在「显示日志」中查看。",
      stderr: "boom",
    });
    const killed = { reason: "exited", code: null, signal: "SIGKILL", stderr: [] } as const;
    expect(failurePage(backend(killed), en)).toMatchObject({
      message: `It was ended by SIGKILL.\n${en.text.failed}`,
      stderr: "",
    });
    for (const failure of [
      { reason: "no-listening", stderr: ["a", "b"] },
      { reason: "token", stderr: ["a", "b"] },
      { reason: "unanswered", stderr: ["a", "b"] },
    ] as const) {
      expect(failurePage(backend(failure), zh)).toEqual({
        title: zh.text.serverStopped,
        message: `${zh.text.serverStop(failure)}\n${zh.text.failed}`,
        stderr: "a\nb",
      });
    }
  });

  test("a spawn that failed: its error under the details, where its stderr would be", () => {
    const failed = { reason: "error", message: "spawn EACCES", stderr: [] } as const;
    expect(failurePage(backend(failed), en)).toEqual({
      title: "Eidolon's server stopped",
      message: `It couldn't be started.\n${en.text.failed}`,
      stderr: "spawn EACCES",
    });
  });

  test("another Eidolon on the data home: who it is", () => {
    const held: BackendFailure = {
      reason: "held",
      holder: { pid: 4821, port: 7861 },
      stderr: ["eidolon: Eidolon is already running on this data home (pid 4821, port 7861)"],
    };
    expect(failurePage(backend(held), en)).toEqual({
      title: "Another Eidolon is using this data home",
      message: en.text.heldDetail({ pid: 4821, port: 7861 }),
      stderr: "eidolon: Eidolon is already running on this data home (pid 4821, port 7861)",
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

describe("the menus' commands to the app's page", () => {
  function commands(): { commands: PageCommands; sent: string[] } {
    const sent: string[] = [];
    return { sent, commands: new PageCommands((command) => sent.push(command)) };
  }

  test("go at once while the page listens", () => {
    const { commands: page, sent } = commands();
    page.listening();
    page.send("settings");
    expect(sent).toEqual(["settings"]);
  });

  test("wait while it doesn't: a new window, the loading page, a page still loading", () => {
    const { commands: page, sent } = commands();
    page.send("settings");
    page.send("settings");
    expect(sent).toEqual([]);
    page.listening();
    expect(sent).toEqual(["settings"]);
    page.listening();
    expect(sent).toEqual(["settings"]);
  });

  test("a new document listens only once it says so", () => {
    const { commands: page, sent } = commands();
    page.listening();
    page.replaced();
    page.send("settings");
    expect(sent).toEqual([]);
    page.listening();
    expect(sent).toEqual(["settings"]);
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
