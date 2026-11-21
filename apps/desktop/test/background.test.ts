// Background mode's decisions: when it's on, and that with it on nothing reaches Electron's calls
// that would show a window, a box, a menu, a panel or another app, or take the focus.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageBoxOptions } from "electron";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  activationPolicy,
  backgroundMicrophone,
  backgroundMode,
  backgroundWindowOptions,
  DownloadPaths,
  hasTray,
  type NativeUi,
  nativeUi,
  showCalls,
} from "../src/main/background.ts";

function recorder() {
  const lines: string[] = [];
  return { lines, log: { info: (line: string) => void lines.push(line) } };
}

describe("backgroundMode", () => {
  test("is on only for an on value of EIDOLON_DESKTOP_BACKGROUND, in any case and spacing", () => {
    for (const value of ["1", "true", " Yes ", "ON"]) {
      expect(backgroundMode({ EIDOLON_DESKTOP_BACKGROUND: value }, "darwin"), value).toBe(true);
    }
    for (const value of ["0", "false", "no", "OFF", "", " ", "maybe"]) {
      expect(backgroundMode({ EIDOLON_DESKTOP_BACKGROUND: value }, "darwin"), value).toBe(false);
    }
    expect(backgroundMode({}, "darwin")).toBe(false);
  });

  test("names its variable without case on Windows alone", () => {
    expect(backgroundMode({ eidolon_desktop_background: "1" }, "darwin")).toBe(false);
    expect(backgroundMode({ eidolon_desktop_background: "1" }, "win32")).toBe(true);
  });
});

test("off, the app is a regular one; on, it's an accessory on macOS, with no taskbar button or tray on Windows", () => {
  expect(activationPolicy("darwin", false)).toBeNull();
  expect(activationPolicy("darwin", true)).toBe("accessory");
  expect(activationPolicy("win32", true)).toBeNull();
  expect(backgroundWindowOptions("win32", false)).toEqual({});
  expect(backgroundWindowOptions("win32", true)).toEqual({ skipTaskbar: true });
  expect(backgroundWindowOptions("darwin", true)).toEqual({});
  expect(hasTray("win32", false)).toBe(true);
  expect(hasTray("win32", true)).toBe(false);
  expect(hasTray("darwin", false)).toBe(false);
});

describe("showCalls", () => {
  test("off: maximized at its first paint if it was, restored if minimized, then shown and focused", () => {
    expect(showCalls(false, { minimized: false, maximize: false })).toEqual(["show", "focus"]);
    expect(showCalls(false, { minimized: false, maximize: true })).toEqual([
      "maximize",
      "show",
      "focus",
    ]);
    expect(showCalls(false, { minimized: true, maximize: false })).toEqual([
      "restore",
      "show",
      "focus",
    ]);
  });

  test("on: nothing at all, maximize included, which shows a hidden window", () => {
    for (const minimized of [false, true]) {
      for (const maximize of [false, true]) {
        expect(showCalls(true, { minimized, maximize })).toEqual([]);
      }
    }
  });
});

test("the microphone goes only to Chromium's fake device, and macOS is never asked", () => {
  const { lines, log } = recorder();
  expect(backgroundMicrophone(true, log)).toBe(true);
  expect(backgroundMicrophone(false, log)).toBe(false);
  expect(lines).toEqual([
    "Eidolon: background mode gave the page the microphone without asking macOS",
    "Eidolon: background mode denied the page the microphone: only Chromium's fake device (--use-fake-device-for-media-stream) may answer",
  ]);
});

describe("DownloadPaths", () => {
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "eidolon-desktop-downloads-"));
  });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  test("saves under the name Chromium suggests, numbered while a file has it", () => {
    writeFileSync(join(folder, "photo.jpg"), "");
    writeFileSync(join(folder, "photo (1).jpg"), "");
    writeFileSync(join(folder, ".env"), "");
    const paths = new DownloadPaths(folder, existsSync);
    expect(paths.next("photo.jpg")).toBe(join(folder, "photo (2).jpg"));
    expect(paths.next("notes")).toBe(join(folder, "notes"));
    expect(paths.next(".env")).toBe(join(folder, ".env (1)"));
  });

  test("gives two downloads of one name two paths, though neither file has landed", () => {
    const paths = new DownloadPaths(folder, existsSync);
    expect(paths.next("status.json")).toBe(join(folder, "status.json"));
    expect(paths.next("status.json")).toBe(join(folder, "status (1).json"));
    expect(paths.next("notes")).toBe(join(folder, "notes"));
    expect(paths.next("notes")).toBe(join(folder, "notes (1)"));
  });

  test("stays in its folder whatever the name", () => {
    const paths = new DownloadPaths(folder, () => false);
    expect(paths.next("../../a.txt")).toBe(join(folder, "a.txt"));
    expect(paths.next("..\\..\\b.txt")).toBe(join(folder, "b.txt"));
    expect(paths.next("")).toBe(join(folder, "download"));
    expect(paths.next(".")).toBe(join(folder, "download (1)"));
    expect(paths.next("..")).toBe(join(folder, "download (2)"));
  });
});

describe("nativeUi", () => {
  function electron(): { ui: NativeUi; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      ui: {
        messageBox: async (box) => {
          calls.push(`messageBox ${box.message}`);
          return { response: 1, checkboxChecked: false };
        },
        openExternal: async (url) => void calls.push(`openExternal ${url}`),
        openPath: async (path) => {
          calls.push(`openPath ${path}`);
          return "";
        },
        aboutPanel: (panel) => void calls.push(`aboutPanel ${panel.applicationName}`),
        stealFocus: () => void calls.push("stealFocus"),
        popup: (menu) => void calls.push(`popup ${menu.length}`),
      },
    };
  }

  const quitBox: MessageBoxOptions = {
    type: "warning",
    title: "Eidolon",
    message: "Quit Eidolon?",
    detail: "Quitting stops a job.",
    buttons: ["Quit", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };

  test("off, it is Electron's own calls", async () => {
    const { ui, calls } = electron();
    const { lines, log } = recorder();
    const off = nativeUi(false, ui, log);
    expect(off).toBe(ui);
    expect(await off.messageBox(quitBox)).toEqual({ response: 1, checkboxChecked: false });
    expect(calls).toEqual(["messageBox Quit Eidolon?"]);
    expect(lines).toEqual([]);
  });

  test("on, a message box is logged with its text and answered with its default button", async () => {
    const { ui, calls } = electron();
    const { lines, log } = recorder();
    const on = nativeUi(true, ui, log);
    expect(await on.messageBox(quitBox)).toEqual({ response: 0, checkboxChecked: false });
    expect(await on.messageBox({ ...quitBox, defaultId: 1 })).toEqual({
      response: 1,
      checkboxChecked: false,
    });
    // With no defaultId, macOS's default is the first button, and a box with none has OK.
    expect(
      await on.messageBox({ message: "Microphone is off", buttons: ["OK"], checkboxChecked: true }),
    ).toEqual({ response: 0, checkboxChecked: true });
    expect(await on.messageBox({ message: "Hidden" })).toEqual({
      response: 0,
      checkboxChecked: false,
    });
    expect(calls).toEqual([]);
    expect(lines).toEqual([
      'Eidolon: background mode answered "Quit" to a message box: Quit Eidolon? Quitting stops a job.',
      'Eidolon: background mode answered "Cancel" to a message box: Quit Eidolon? Quitting stops a job.',
      'Eidolon: background mode answered "OK" to a message box: Microphone is off',
      'Eidolon: background mode answered "OK" to a message box: Hidden',
    ]);
  });

  test("on, links, folders, the About panel and menus are logged and nothing opens or takes the focus", async () => {
    const { ui, calls } = electron();
    const { lines, log } = recorder();
    const on = nativeUi(true, ui, log);
    await on.openExternal("https://example.com/a?token=secret#x");
    expect(await on.openPath("/tmp/profile/logs")).toBe("");
    on.aboutPanel({
      applicationName: "Eidolon",
      applicationVersion: "0.0.0-dev",
      version: "Server 0.13.0",
    });
    on.aboutPanel({ applicationName: "Eidolon", applicationVersion: "0.1.0", credits: "" });
    on.stealFocus();
    on.popup(
      [
        { role: "cut", label: "Cut" },
        { role: "copy", label: "Copy" },
        { type: "separator" },
        { role: "selectAll", label: "Select All" },
      ],
      {},
    );
    expect(calls).toEqual([]);
    expect(lines).toEqual([
      "Eidolon: background mode didn't open https://example.com/a in the default browser",
      "Eidolon: background mode didn't open /tmp/profile/logs",
      "Eidolon: background mode didn't show the About panel: Eidolon 0.0.0-dev (Server 0.13.0)",
      "Eidolon: background mode didn't show the About panel: Eidolon 0.1.0",
      "Eidolon: background mode didn't open a menu: Cut, Copy, Select All",
    ]);
  });
});
