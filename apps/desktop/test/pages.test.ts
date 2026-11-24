// Which page the window shows as the backend's state and the window's own failures move it, what
// the failure page says, what Try Again does, and when the page's beforeunload holds.
import { describe, expect, test } from "vitest";
import { BearerToken } from "../src/main/attach.ts";
import type { BackendFailure, BackendState } from "../src/main/controller.ts";
import {
  type Failure,
  failurePage,
  PageCommands,
  PageUnloads,
  shellPageStrings,
  type WindowPage,
  WindowPages,
} from "../src/main/pages.ts";
import { QuitFlow } from "../src/main/quit-flow.ts";
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
/** Our backend after a restart: the same address, another process. */
const RESTARTED: BackendState = { ...READY, pid: 4343 };
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

  test("reloads the app for a new server whose version couldn't be read, and not again once it reads", () => {
    const { pages: window, loads, server } = pages();
    window.opened(READY);
    // Our backend restarts, and the new one's status misses its deadline.
    window.backend(HOLDING);
    server.version = "";
    window.backend(RESTARTED);
    expect(loads).toEqual(["app", "reload"]);
    // A hold on that same server ends, and its version reads this time: the page came from it.
    window.backend(HOLDING);
    server.version = "0.13.0";
    window.backend(RESTARTED);
    expect(loads).toEqual(["app", "reload"]);
    // The next server is compared with the version read late.
    window.backend(HOLDING);
    window.backend(READY);
    expect(loads).toEqual(["app", "reload"]);
  });

  test("keeps the app shown from a server whose version couldn't be read once it reads", () => {
    const { pages: window, loads, server } = pages();
    server.version = "";
    window.opened(STARTING);
    window.backend(ATTACHED);
    // An idle close's grace proves the same server again, and its version reads this time.
    window.backend(HOLDING_ATTACHED);
    server.version = "0.13.0";
    window.backend({ ...ATTACHED });
    expect(loads).toEqual(["loading", "app"]);
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

describe("the page's beforeunload", () => {
  const settle = () => new Promise((done) => setTimeout(done, 0));

  /**
   * The page's unloads on a real quit flow whose box answers through `answer`. `closing` holds
   * whether the page goes each time the quit, or the update's install, closes the window.
   */
  function onQuitFlow() {
    let answer: (approved: boolean) => void = () => {};
    const closing: boolean[] = [];
    const flow: QuitFlow = new QuitFlow({
      confirm: () =>
        new Promise<boolean>((done) => {
          answer = done;
        }),
      hideWindows: () => {},
      stopBackend: async () => {},
      quit: () => closing.push(unloads.goes()),
      log: { info: () => {}, error: () => {} },
    });
    const unloads = new PageUnloads(() => flow.quitting);
    return { flow, unloads, closing, answer: (approved: boolean) => answer(approved) };
  }

  test("holds against the page's own reloads and navigations", () => {
    expect(onQuitFlow().unloads.goes()).toBe(false);
  });

  test("gives way to a quit once it's approved, never while its box asks or after a Cancel", async () => {
    const quit = onQuitFlow();
    quit.flow.beforeQuit();
    await settle();
    expect(quit.unloads.goes()).toBe(false);
    quit.answer(false);
    await settle();
    expect(quit.unloads.goes()).toBe(false);
    quit.flow.beforeQuit();
    await settle();
    quit.answer(true);
    await settle();
    expect(quit.closing).toEqual([true]);
  });

  test("gives way to the update's restart, whose install closes the window", async () => {
    const quit = onQuitFlow();
    const restarted = quit.flow.restart(
      () => quit.closing.push(quit.unloads.goes()),
      () => true,
    );
    await settle();
    expect(quit.unloads.goes()).toBe(false);
    quit.answer(true);
    expect(await restarted).toBe(true);
    expect(quit.closing).toEqual([true]);
  });

  test("gives way to main's own load from its call until it settles, the load replacing it included", async () => {
    const { unloads } = onQuitFlow();
    const first = Promise.withResolvers<void>();
    const next = Promise.withResolvers<void>();
    const loading = unloads.mainLoad(() => first.promise);
    expect(unloads.goes()).toBe(true);
    const replacing = unloads.mainLoad(() => next.promise);
    first.reject(new Error("ERR_ABORTED (-3) loading 'eidolon-app://shell/loading'"));
    await expect(loading).rejects.toThrow("ERR_ABORTED");
    expect(unloads.goes()).toBe(true);
    next.resolve();
    await replacing;
    expect(unloads.goes()).toBe(false);
  });
});

describe("the page's unsaved edits", () => {
  test("are the app page's word, kept until it says otherwise", () => {
    const unloads = new PageUnloads(() => false);
    expect(unloads.unsaved).toBe(false);
    unloads.held(true);
    unloads.held(true);
    expect(unloads.unsaved).toBe(true);
    unloads.held(false);
    expect(unloads.unsaved).toBe(false);
  });

  test("go with the page's document: a new one committed, or its renderer gone", () => {
    const unloads = new PageUnloads(() => false);
    unloads.held(true);
    unloads.gone();
    expect(unloads.unsaved).toBe(false);
    // The next document holds edits of its own once it says so.
    unloads.held(true);
    expect(unloads.unsaved).toBe(true);
  });

  test("go as main starts a load of its own, which lets the page go, edits and all", async () => {
    const unloads = new PageUnloads(() => false);
    unloads.held(true);
    const load = Promise.withResolvers<void>();
    const loading = unloads.mainLoad(() => load.promise);
    expect(unloads.unsaved).toBe(false);
    load.resolve();
    await loading;
    expect(unloads.unsaved).toBe(false);
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
