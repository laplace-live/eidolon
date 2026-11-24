// The app page's invokes: each refuses any sender but the app's main frame before it acts, and
// takes only its own argument.
import { describe, expect, test } from "vitest";
import { type AppInvokes, appInvokes, type InvokeAnswer } from "../src/main/app-invokes.ts";
import { BRIDGE, type IpcSender, type PageChannel } from "../src/shared/bridge.ts";

const app: IpcSender = { window: "main", mainFrame: true, origin: "eidolon-app://app" };
const others: Readonly<Record<string, IpcSender>> = {
  "the shell's page": { window: "main", mainFrame: true, origin: "eidolon-app://shell" },
  "a subframe": { window: "main", mainFrame: false, origin: "eidolon-app://app" },
  "another webContents": { window: null, mainFrame: false, origin: "eidolon-app://app" },
  "a frame that's gone": { window: "main", mainFrame: true, origin: null },
  "a sandboxed document": { window: "main", mainFrame: true, origin: "null" },
  "the desktop companion's page": {
    window: "companion",
    mainFrame: true,
    origin: "eidolon-app://app",
  },
};

const INSTALLED = { state: "installed", path: "/usr/local/bin/eidolon" } as const;

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
  };
  const list = appInvokes(actions);
  const answer = (channel: PageChannel): InvokeAnswer => {
    const found = list.find(([listed]) => listed === channel);
    if (found === undefined) throw new Error(`no invoke on ${channel}`);
    return found[1];
  };
  return { list, answer, calls };
}

describe("appInvokes", () => {
  test("answers the folder dialog and the system options, one invoke each", () => {
    expect(invokes().list.map(([channel]) => channel)).toEqual([
      BRIDGE.chooseFolder,
      BRIDGE.loginItem,
      BRIDGE.setLoginItem,
      BRIDGE.terminalCommand,
      BRIDGE.setTerminalCommand,
    ]);
  });

  test("refuses every other sender at once, before it acts or looks at the argument", () => {
    const { list, calls } = invokes();
    for (const [channel, answer] of list) {
      for (const [name, sender] of Object.entries(others)) {
        // Thrown, not a rejection: nothing awaits before the check. A bad argument is refused as
        // the sender, so the argument is never looked at first.
        for (const argument of [true, "install", "x", undefined]) {
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
    expect(calls).toEqual([["chooseFolder"], ["loginItem"], ["terminalCommand"]]);
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
});
