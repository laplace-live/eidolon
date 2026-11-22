// The quit flow's choices: a close hides, every quit asks once when work would be cut, then hides,
// stops our own backend and quits; power-off and the session's end don't ask. The restart that
// installs an update takes the same way, with install in place of the quit. And Windows' one-time
// tray notice.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HideNotice, QuitFlow } from "../src/main/quit-flow.ts";

/**
 * A flow whose box answers through `answer`, recording what it does. Asked again while open, the
 * box joins the open decision, as QuitConfirmation's does.
 */
function flow() {
  const steps: string[] = [];
  let answer: (approved: boolean) => void = () => {};
  let open: Promise<boolean> | null = null;
  let stopped: () => void = () => {};
  let asked = 0;
  const quitFlow = new QuitFlow({
    confirm: (purpose) => {
      asked++;
      if (open !== null) return open;
      steps.push(purpose === "restart" ? "confirm restart" : "confirm");
      open = new Promise<boolean>((done) => {
        answer = done;
      }).finally(() => {
        open = null;
      });
      return open;
    },
    hideWindows: () => steps.push("hide"),
    stopBackend: () => {
      steps.push("stop");
      return new Promise((done) => {
        stopped = done;
      });
    },
    quit: () => steps.push("quit"),
    log: { info: () => {}, error: (message) => steps.push(`error: ${message}`) },
  });
  return {
    flow: quitFlow,
    steps,
    asked: () => asked,
    answer: (approved: boolean) => answer(approved),
    stopped: () => stopped(),
  };
}

const settle = () => new Promise((done) => setTimeout(done, 0));
/** A restart whose update stays installable. */
const installable = () => true;

describe("closing", () => {
  test("hides the window until a quit is approved, then lets it close", async () => {
    const quit = flow();
    expect(quit.flow.closeHides()).toBe(true);
    expect(quit.flow.beforeQuit()).toBe(false);
    await settle();
    // The box is open: a close still hides.
    expect(quit.flow.closeHides()).toBe(true);
    quit.answer(true);
    await settle();
    expect(quit.flow.closeHides()).toBe(false);
    expect(quit.flow.quitting).toBe(true);
  });
});

describe("quitting", () => {
  test("asks, then hides, stops the backend, and quits through a before-quit it lets by", async () => {
    const quit = flow();
    expect(quit.flow.beforeQuit()).toBe(false);
    await settle();
    expect(quit.steps).toEqual(["confirm"]);
    quit.answer(true);
    await settle();
    expect(quit.steps).toEqual(["confirm", "hide", "stop"]);
    // Still stopping: another quit waits on this one.
    expect(quit.flow.beforeQuit()).toBe(false);
    quit.stopped();
    await settle();
    expect(quit.steps).toEqual(["confirm", "hide", "stop", "quit"]);
    expect(quit.flow.beforeQuit()).toBe(true);
  });

  test("cancelled, nothing happens, and the next quit asks again", async () => {
    const quit = flow();
    quit.flow.beforeQuit();
    await settle();
    quit.answer(false);
    await settle();
    expect(quit.steps).toEqual(["confirm"]);
    expect(quit.flow.closeHides()).toBe(true);
    expect(quit.flow.beforeQuit()).toBe(false);
    await settle();
    expect(quit.asked()).toBe(2);
  });

  test("a quit while the box is open joins it, rather than stacking another", async () => {
    const quit = flow();
    quit.flow.beforeQuit();
    await settle();
    quit.flow.beforeQuit();
    quit.flow.beforeQuit();
    await settle();
    // QuitConfirmation joins a repeated confirm() and brings its box forward.
    expect(quit.asked()).toBe(3);
    quit.answer(true);
    await settle();
    expect(quit.steps.filter((step) => step === "hide")).toEqual(["hide"]);
  });

  test("macOS powering off doesn't ask, until the window has the owner's attention again", async () => {
    const off = flow();
    off.flow.poweringOff();
    off.flow.beforeQuit();
    await settle();
    expect(off.steps).toEqual(["hide", "stop"]);

    const cancelled = flow();
    cancelled.flow.poweringOff();
    cancelled.flow.attention();
    cancelled.flow.beforeQuit();
    await settle();
    expect(cancelled.steps).toEqual(["confirm"]);
  });

  test("a check that throws quits anyway, and says so", async () => {
    const steps: string[] = [];
    const quit = new QuitFlow({
      confirm: () => Promise.reject(new Error("no box")),
      hideWindows: () => steps.push("hide"),
      stopBackend: async () => {
        steps.push("stop");
      },
      quit: () => steps.push("quit"),
      log: { info: () => {}, error: (message) => steps.push(message) },
    });
    quit.beforeQuit();
    await settle();
    await settle();
    expect(steps).toEqual([
      "Eidolon: the quit check failed, quitting anyway: Error: no box",
      "hide",
      "stop",
      "quit",
    ]);
  });

  test("a restart asks in its own words, then latches, hides and stops the backend, and installs in place of the quit", async () => {
    const quit = flow();
    const restarted = quit.flow.restart(() => {
      // quitAndInstall closes every window, then quits: both must go through by now.
      quit.steps.push(
        `install (a close hides: ${quit.flow.closeHides()}; before-quit lets by: ${quit.flow.beforeQuit()})`,
      );
    }, installable);
    await settle();
    expect(quit.steps).toEqual(["confirm restart"]);
    // The box is open: nothing is latched yet.
    expect(quit.flow.closeHides()).toBe(true);
    quit.answer(true);
    await settle();
    expect(quit.steps).toEqual(["confirm restart", "hide", "stop"]);
    expect(quit.flow.closeHides()).toBe(false);
    quit.stopped();
    expect(await restarted).toBe(true);
    expect(quit.steps).toEqual([
      "confirm restart",
      "hide",
      "stop",
      "install (a close hides: false; before-quit lets by: true)",
    ]);
  });

  test("a restart whose update can't install once the box is answered goes no further: no latch, no hide, no stop", async () => {
    const quit = flow();
    let failed = false;
    const asked: boolean[] = [];
    const restarted = quit.flow.restart(
      () => quit.steps.push("install"),
      () => {
        asked.push(!failed);
        return !failed;
      },
    );
    await settle();
    // Not while the box is open.
    expect(asked).toEqual([]);
    failed = true;
    quit.answer(true);
    await settle();
    expect(asked).toEqual([false]);
    expect(quit.steps).toEqual(["confirm restart"]);
    expect([quit.flow.quitting, quit.flow.closeHides()]).toEqual([false, true]);
    expect(await restarted).toBe(false);
    expect(quit.flow.beforeQuit()).toBe(false);
    await settle();
    expect(quit.steps).toEqual(["confirm restart", "confirm"]);
  });

  test("a cancelled restart resolves false and leaves everything running; the next quit asks as a quit", async () => {
    const quit = flow();
    const restarted = quit.flow.restart(
      () => quit.steps.push("install"),
      () => quit.steps.push("installable?") > 0,
    );
    await settle();
    quit.answer(false);
    expect(await restarted).toBe(false);
    expect(quit.steps).toEqual(["confirm restart"]);
    expect(quit.flow.closeHides()).toBe(true);
    expect(quit.flow.beforeQuit()).toBe(false);
    await settle();
    expect(quit.steps).toEqual(["confirm restart", "confirm"]);
  });

  test("a quit while the restart's box is open joins it, and the restart goes on as answered", async () => {
    const quit = flow();
    const restarted = quit.flow.restart(() => quit.steps.push("install"), installable);
    await settle();
    expect(quit.flow.beforeQuit()).toBe(false);
    expect(quit.asked()).toBe(2);
    quit.answer(true);
    await settle();
    quit.stopped();
    expect(await restarted).toBe(true);
    expect(quit.steps).toEqual(["confirm restart", "hide", "stop", "install"]);
  });

  test("a restart while a quit asks or stops goes nowhere: the quit's box comes forward, and the quit goes on", async () => {
    const quit = flow();
    quit.flow.beforeQuit();
    await settle();
    expect(await quit.flow.restart(() => quit.steps.push("install"), installable)).toBe(false);
    expect(quit.asked()).toBe(2);
    quit.answer(true);
    await settle();
    expect(await quit.flow.restart(() => quit.steps.push("install"), installable)).toBe(false);
    quit.stopped();
    await settle();
    expect(quit.steps).toEqual(["confirm", "hide", "stop", "quit"]);
  });

  test("Windows' session end lets every quit through, a box still open included", async () => {
    const quit = flow();
    quit.flow.beforeQuit();
    await settle();
    quit.flow.sessionEnded();
    expect(quit.flow.beforeQuit()).toBe(true);
    expect(quit.flow.closeHides()).toBe(false);
    quit.answer(true);
    await settle();
    expect(quit.steps).toEqual(["confirm"]);
  });
});

describe("Windows' tray notice", () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "eidolon-hide-notice-"));
  });
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  test("shows after the first hide only, and its marker keeps it from later runs", async () => {
    const marker = join(folder, "profile", "tray-notice-shown");
    let shown = 0;
    const notice = () =>
      new HideNotice({
        marker,
        show: async () => {
          shown++;
        },
        log: { warn: () => {} },
      });
    const first = notice();
    first.hidden();
    first.hidden();
    expect(shown).toBe(1);
    expect(existsSync(marker)).toBe(true);
    notice().hidden();
    expect(shown).toBe(1);
  });

  test("shows once in a run whose marker can't be written, and logs why", () => {
    const blocked = join(folder, "a-file");
    writeFileSync(blocked, "");
    const warnings: string[] = [];
    let shown = 0;
    const notice = new HideNotice({
      marker: join(blocked, "tray-notice-shown"),
      show: async () => {
        shown++;
      },
      log: { warn: (message) => warnings.push(message) },
    });
    notice.hidden();
    notice.hidden();
    expect(shown).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});
