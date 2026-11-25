// The pages' invokes: each refuses any sender but its own window's main frame before it acts, and
// takes only its own argument.
import { describe, expect, test } from "vitest";
import {
  type AppInvokes,
  appInvokes,
  type CompanionInvokes,
  companionInvokes,
  type InvokeAnswer,
} from "../src/main/app-invokes.ts";
import {
  BRIDGE,
  type CompanionMenuState,
  type IpcSender,
  type PageChannel,
} from "../src/shared/bridge.ts";

const app: IpcSender = { window: "main", mainFrame: true, origin: "eidolon-app://app" };
const her: IpcSender = { window: "companion", mainFrame: true, origin: "eidolon-app://app" };
const others: Readonly<Record<string, IpcSender>> = {
  "the shell's page": { window: "main", mainFrame: true, origin: "eidolon-app://shell" },
  "a subframe": { window: "main", mainFrame: false, origin: "eidolon-app://app" },
  "another webContents": { window: null, mainFrame: false, origin: "eidolon-app://app" },
  "a frame that's gone": { window: "main", mainFrame: true, origin: null },
  "a sandboxed document": { window: "main", mainFrame: true, origin: "null" },
  "the desktop companion's page": her,
};

const INSTALLED = { state: "installed", path: "/usr/local/bin/eidolon" } as const;
const STATE = { on: true, showAtLogin: true, background: false } as const;

/** Finds `channel`'s answer in `list`. */
function answerIn(
  list: readonly (readonly [PageChannel, InvokeAnswer])[],
  channel: PageChannel,
): InvokeAnswer {
  const found = list.find(([listed]) => listed === channel);
  if (found === undefined) throw new Error(`no invoke on ${channel}`);
  return found[1];
}

/** The invokes, on actions that record each call and answer as main would. */
function invokes() {
  const calls: unknown[][] = [];
  const actions: AppInvokes = {
    chooseFolder: async (...args: unknown[]) => {
      calls.push(["chooseFolder", ...args]);
      return "/Users/me/Projects";
    },
    loginItem: (...args: unknown[]) => {
      calls.push(["loginItem", ...args]);
      return { state: "off" };
    },
    setLoginItem: (on) => {
      calls.push(["setLoginItem", on]);
      return { state: on ? "on" : "off" };
    },
    terminalCommand: async (...args: unknown[]) => {
      calls.push(["terminalCommand", ...args]);
      return INSTALLED;
    },
    setTerminalCommand: async (action) => {
      calls.push(["setTerminalCommand", action]);
      return { command: INSTALLED };
    },
    companion: (...args: unknown[]) => {
      calls.push(["companion", ...args]);
      return STATE;
    },
    setCompanion: (change) => {
      calls.push(["setCompanion", change]);
      return STATE;
    },
    popOut: (...args: unknown[]) => {
      calls.push(["popOut", ...args]);
      return STATE;
    },
    resetCompanionPlace: (...args: unknown[]) => {
      calls.push(["resetCompanionPlace", ...args]);
      return STATE;
    },
    revealModel: (model) => {
      calls.push(["revealModel", model]);
      return model.model === "tml";
    },
  };
  const list = appInvokes(actions);
  return { list, answer: (channel: PageChannel) => answerIn(list, channel), calls };
}

describe("appInvokes", () => {
  test("answers the folder dialog, the system options and the desktop companion, one invoke each", () => {
    expect(invokes().list.map(([channel]) => channel)).toEqual([
      BRIDGE.chooseFolder,
      BRIDGE.loginItem,
      BRIDGE.setLoginItem,
      BRIDGE.terminalCommand,
      BRIDGE.setTerminalCommand,
      BRIDGE.companion,
      BRIDGE.setCompanion,
      BRIDGE.popOut,
      BRIDGE.resetCompanionPlace,
      BRIDGE.revealModel,
    ]);
  });

  test("refuses every other sender at once, before it acts or looks at the argument", () => {
    const { list, calls } = invokes();
    for (const [channel, answer] of list) {
      for (const [name, sender] of Object.entries(others)) {
        // Thrown, not a rejection: nothing awaits before the check. A bad argument is refused as
        // the sender, so the argument is never looked at first.
        for (const argument of [true, "install", "x", undefined, { on: true }]) {
          expect(() => answer(sender, argument), `${channel} from ${name}`).toThrow("refused");
        }
      }
    }
    expect(calls).toEqual([]);
  });

  test("hands the app's page each action's answer, the dialog and the reads taking no argument", async () => {
    const { answer, calls } = invokes();
    expect(await answer(BRIDGE.chooseFolder)(app, "/etc")).toBe("/Users/me/Projects");
    expect(answer(BRIDGE.loginItem)(app, true)).toEqual({ state: "off" });
    expect(await answer(BRIDGE.terminalCommand)(app, "remove")).toEqual(INSTALLED);
    expect(answer(BRIDGE.companion)(app, { on: false })).toEqual(STATE);
    expect(answer(BRIDGE.popOut)(app, "x")).toEqual(STATE);
    expect(answer(BRIDGE.resetCompanionPlace)(app, { feet: 1 })).toEqual(STATE);
    expect(calls).toEqual([
      ["chooseFolder"],
      ["loginItem"],
      ["terminalCommand"],
      ["companion"],
      ["popOut"],
      ["resetCompanionPlace"],
    ]);
  });

  test("turns Open at Login on or off with a boolean alone", () => {
    const { answer, calls } = invokes();
    const set = answer(BRIDGE.setLoginItem);
    expect(set(app, true)).toEqual({ state: "on" });
    expect(set(app, false)).toEqual({ state: "off" });
    for (const on of ["true", 1, 0, null, undefined, {}, [true]]) {
      expect(() => set(app, on), String(on)).toThrow("Open at Login takes true or false");
    }
    expect(calls).toEqual([
      ["setLoginItem", true],
      ["setLoginItem", false],
    ]);
  });

  test("installs or removes the terminal command, and takes nothing else", async () => {
    const { answer, calls } = invokes();
    const change = answer(BRIDGE.setTerminalCommand);
    expect(await change(app, "install")).toEqual({ command: INSTALLED });
    expect(await change(app, "remove")).toEqual({ command: INSTALLED });
    for (const action of ["Install", "uninstall", "rm -rf /", "", null, ["install"]]) {
      expect(() => change(app, action), String(action)).toThrow(
        "the terminal command takes install or remove",
      );
    }
    expect(calls).toEqual([
      ["setTerminalCommand", "install"],
      ["setTerminalCommand", "remove"],
    ]);
  });

  test("changes the desktop companion with on or showAtLogin alone, each a boolean", () => {
    const { answer, calls } = invokes();
    const set = answer(BRIDGE.setCompanion);
    expect(set(app, { on: true })).toEqual(STATE);
    expect(set(app, { showAtLogin: false })).toEqual(STATE);
    for (const change of [
      {},
      { on: "yes" },
      { on: true, x: 1 },
      { on: true, x: true },
      { x: true },
      true,
      null,
      undefined,
    ]) {
      expect(() => set(app, change), JSON.stringify(change)).toThrow("the desktop companion takes");
    }
    expect(calls).toEqual([
      ["setCompanion", { on: true }],
      ["setCompanion", { showAtLogin: false }],
    ]);
  });
});

/** Her menu's state, as her page would send it. */
const MENU_STATE: CompanionMenuState = {
  call: "idle",
  live: false,
  micOn: true,
  models: [{ id: "milky", name: "奶绿" }],
  model: "milky",
  outfits: [],
  outfit: null,
};

/** Her invokes, on actions that record each call. */
function herInvokes() {
  const calls: unknown[][] = [];
  const actions: CompanionInvokes = {
    shape: (shape) => {
      calls.push(["shape", shape]);
      return { width: 202, height: 480 };
    },
    menu: async (state) => {
      calls.push(["menu", state]);
      return "hide";
    },
  };
  const list = companionInvokes(actions);
  return { list, answer: (channel: PageChannel) => answerIn(list, channel), calls };
}

describe("companionInvokes", () => {
  test("answers her shape and her menu, one invoke each", () => {
    expect(herInvokes().list.map(([channel]) => channel)).toEqual([
      BRIDGE.companionShape,
      BRIDGE.companionMenu,
    ]);
  });

  test("refuses the main window's page and every other sender, before it acts or reads the argument", () => {
    const { list, calls } = herInvokes();
    const senders = [
      ...Object.entries(others).filter(([, sender]) => sender !== her),
      ["the main window's app page", app] as const,
    ];
    for (const [channel, answer] of list) {
      for (const [name, sender] of senders) {
        for (const argument of [{ kind: "picture" }, MENU_STATE, "x", undefined]) {
          expect(() => answer(sender, argument), `${channel} from ${name}`).toThrow("refused");
        }
      }
    }
    expect(calls).toEqual([]);
  });

  test("takes her shape and her menu's state from her page alone, in their shapes", async () => {
    const { answer, calls } = herInvokes();
    expect(answer(BRIDGE.companionShape)(her, { kind: "model", aspect: 0.5, x: 1 })).toEqual({
      width: 202,
      height: 480,
    });
    expect(await answer(BRIDGE.companionMenu)(her, MENU_STATE)).toBe("hide");
    for (const shape of [{ kind: "model", aspect: 40 }, { kind: "video" }, null]) {
      expect(() => answer(BRIDGE.companionShape)(her, shape)).toThrow("her shape");
    }
    for (const state of [
      { ...MENU_STATE, call: "ringing" },
      { ...MENU_STATE, models: "x" },
      null,
    ]) {
      expect(() => answer(BRIDGE.companionMenu)(her, state)).toThrow("her menu");
    }
    expect(calls).toEqual([
      ["shape", { kind: "model", aspect: 0.5 }],
      ["menu", MENU_STATE],
    ]);
  });

  test("shows a model by a persona's id and a model's id alone, never a path", () => {
    const { answer, calls } = invokes();
    const reveal = answer(BRIDGE.revealModel);
    expect(reveal(app, { persona: "milky-green", model: "tml", x: "/etc" })).toBe(true);
    expect(reveal(app, { persona: "milky-green", model: "gone" })).toBe(false);
    for (const model of [
      { persona: "../etc", model: "tml" },
      { persona: "milky-green", model: "a/b" },
      { persona: "milky-green", model: ".." },
      { persona: "Milky", model: "tml" },
      { persona: "milky-green" },
      "milky-green/tml",
      null,
    ]) {
      expect(() => reveal(app, model), JSON.stringify(model)).toThrow(
        "a model is a persona's id and a model's id",
      );
    }
    expect(calls).toEqual([
      ["revealModel", { persona: "milky-green", model: "tml" }],
      ["revealModel", { persona: "milky-green", model: "gone" }],
    ]);
  });
});
