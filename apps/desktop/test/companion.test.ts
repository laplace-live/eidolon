// The desktop companion's settings file, her window's size and place on the displays, her window's
// options, her menu's names, and her log lines.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  areaAt,
  COMPANION_FILE,
  COMPANION_LINES,
  type CompanionSettings,
  companionLine,
  companionSize,
  companionWindowSetup,
  DEFAULT_ASPECT,
  DEFAULT_COMPANION,
  dragged,
  EDGE_DIP,
  feetOf,
  keepShown,
  LABEL_CHARS,
  menuLabel,
  placement,
  readCompanion,
  settled,
  writeCompanion,
} from "../src/main/companion.ts";
import { COMPANION_SWITCH } from "../src/shared/bridge.ts";

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "eidolon-companion-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** A laptop's display, and its work area under macOS's menu bar and above its Dock. */
const laptopDisplay = { x: 0, y: 0, width: 1512, height: 982 };
const laptop = { x: 0, y: 25, width: 1512, height: 875 };
/** A second display to its right, taller, under its own menu bar. */
const externalDisplay = { x: 1512, y: -225, width: 2560, height: 1440 };
const external = { x: 1512, y: -200, width: 2560, height: 1415 };

describe("the settings file", () => {
  test("is the defaults when missing, unreadable or of another shape: off, showing at login, on top, medium, at her first place", () => {
    expect(DEFAULT_COMPANION).toEqual({
      on: false,
      showAtLogin: true,
      alwaysOnTop: true,
      size: "medium",
      feet: null,
    });
    const file = join(folder, COMPANION_FILE);
    expect(readCompanion(file)).toEqual(DEFAULT_COMPANION);
    for (const text of ["{", "[]", "null", '"on"', "1", ""]) {
      writeFileSync(file, text);
      expect([text, readCompanion(file)]).toEqual([text, DEFAULT_COMPANION]);
    }
    // One that can't be read at all: a folder where the file goes.
    const folderInPlace = join(folder, "unreadable", COMPANION_FILE);
    mkdirSync(folderInPlace, { recursive: true });
    expect(readCompanion(folderInPlace)).toEqual(DEFAULT_COMPANION);
  });

  test("keeps what it holds, field by field", () => {
    const file = join(folder, COMPANION_FILE);
    writeFileSync(file, JSON.stringify({ on: true, size: "large", feet: { x: 10, y: 20 } }));
    expect(readCompanion(file)).toEqual({
      ...DEFAULT_COMPANION,
      on: true,
      size: "large",
      feet: { x: 10, y: 20 },
    });
    writeFileSync(file, JSON.stringify({ showAtLogin: false, alwaysOnTop: false }));
    expect(readCompanion(file)).toMatchObject({ showAtLogin: false, alwaysOnTop: false });
  });

  test("each field of another kind falls back alone", () => {
    const file = join(folder, COMPANION_FILE);
    const kept = { on: true, size: "large", feet: { x: 10, y: 20 } };
    for (const [bad, field] of [
      [{ size: "huge" }, { size: "medium" }],
      [{ on: "yes" }, { on: false }],
      [{ feet: { x: 1 } }, { feet: null }],
      [{ feet: { x: "1", y: 2 } }, { feet: null }],
      [{ feet: [1, 2] }, { feet: null }],
      [{ showAtLogin: 0 }, { showAtLogin: true }],
      [{ alwaysOnTop: null }, { alwaysOnTop: true }],
    ] as const) {
      writeFileSync(file, JSON.stringify({ ...kept, ...bad }));
      expect([bad, readCompanion(file)]).toEqual([
        bad,
        { ...DEFAULT_COMPANION, ...kept, ...field },
      ]);
    }
  });

  test("round-trips through a temporary file it leaves nowhere, the folder made as needed", () => {
    const file = join(folder, "profile", COMPANION_FILE);
    const settings: CompanionSettings = {
      on: true,
      showAtLogin: false,
      alwaysOnTop: false,
      size: "small",
      feet: { x: 1488.5, y: 900 },
    };
    writeCompanion(file, settings);
    expect(readCompanion(file)).toEqual(settings);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(readdirSync(join(folder, "profile"))).toEqual([COMPANION_FILE]);
    writeCompanion(file, { ...settings, feet: null });
    expect(readCompanion(file).feet).toBeNull();
  });
});

describe("her window's size", () => {
  test("her model: the size's height, as wide as her framing, within the work area", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(companionSize("medium", { kind: "model", aspect: 0.5 }, area)).toEqual({
      width: 240,
      height: 480,
    });
    expect(companionSize("small", { kind: "model", aspect: DEFAULT_ASPECT }, area)).toEqual({
      width: Math.round(360 * DEFAULT_ASPECT),
      height: 360,
    });
  });

  test("her picture: a square of the size's side", () => {
    const area = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(companionSize("large", { kind: "picture" }, area)).toEqual({ width: 160, height: 160 });
    expect(companionSize("small", { kind: "picture" }, area)).toEqual({ width: 96, height: 96 });
  });

  test("at most 90% of the work area each way, scaled as one", () => {
    const short = { x: 0, y: 0, width: 1366, height: 700 };
    const large = companionSize("large", { kind: "model", aspect: DEFAULT_ASPECT }, short);
    expect(large.height).toBe(630);
    expect(large.width).toBe(Math.round(630 * DEFAULT_ASPECT));
    const narrow = { x: 0, y: 0, width: 400, height: 2000 };
    expect(companionSize("large", { kind: "model", aspect: 4 }, narrow)).toEqual({
      width: 360,
      height: 90,
    });
  });
});

describe("where she stands", () => {
  const size = { width: 202, height: 480 };
  const areas = [laptop, external];
  const displays = [laptopDisplay, externalDisplay];
  /** Her first place on the laptop alone. */
  const first = { x: 1512 - 24 - 202, y: 900 - 480, ...size };

  test("the first time, at the primary work area's bottom right, EDGE_DIP in", () => {
    const rect = placement(null, size, areas, displays);
    expect(rect).toEqual({
      x: laptop.x + laptop.width - EDGE_DIP - size.width,
      y: laptop.y + laptop.height - size.height,
      ...size,
    });
    expect(feetOf(rect)).toEqual({ x: 1512 - 24 - 101, y: 900 });
    expect(placement(null, size, [laptop], [laptopDisplay])).toEqual(first);
  });

  test("where her feet were, on whichever display holds them", () => {
    const feet = { x: 3000, y: 1215 };
    expect(placement(feet, size, areas, displays)).toEqual({ x: 2899, y: 735, ...size });
    expect(feetOf(placement(feet, size, areas, displays))).toEqual(feet);
  });

  test("at her first place once less than a quarter of her window, either way, would show on a display", () => {
    expect(placement({ x: 6000, y: 300 }, size, areas, displays)).toEqual(
      placement(null, size, areas, displays),
    );
    expect(placement({ x: 700, y: 2000 }, size, [laptop], [laptopDisplay])).toEqual(first);
  });

  test("partly off a display, where her feet were, while a quarter of her window shows each way", () => {
    // Below the laptop's bottom edge, her head and shoulders showing.
    expect(placement({ x: 700, y: 1150 }, size, [laptop], [laptopDisplay])).toEqual({
      x: 599,
      y: 670,
      ...size,
    });
    // Past its left edge, 91 of her 202 DIP showing.
    expect(placement({ x: -10, y: 900 }, size, [laptop], [laptopDisplay])).toEqual({
      x: -111,
      y: 420,
      ...size,
    });
    // 41 DIP showing, less than a quarter: back to her first place.
    expect(placement({ x: -60, y: 900 }, size, [laptop], [laptopDisplay])).toEqual(first);
    // A display below the laptop, unplugged: a quarter of her doesn't reach up onto it.
    expect(placement({ x: 700, y: 1400 }, size, [laptop], [laptopDisplay])).toEqual(first);
  });

  test("a Dock or a taskbar that grew under her feet leaves her where she stood", () => {
    // The Dock took 75 DIP more of the laptop's bottom since she was left standing on it.
    const shrunk = { ...laptop, height: laptop.height - 75 };
    const rect = placement({ x: 300, y: 900 }, size, [shrunk], [laptopDisplay]);
    expect(rect).toEqual({ x: 199, y: 420, ...size });
    expect(feetOf(rect)).toEqual({ x: 300, y: 900 });
  });

  test("the work area holding a point, its right and bottom edges included, else the nearest", () => {
    expect(areaAt({ x: 1512, y: 900 }, [laptop, external])).toBe(laptop);
    expect(areaAt({ x: 1513, y: 900 }, [laptop, external])).toBe(external);
    expect(areaAt({ x: -50, y: 400 }, [laptop, external])).toBe(laptop);
    expect(areaAt({ x: 5000, y: 0 }, [laptop, external])).toBe(external);
  });

  test("keepShown moves a window the least way that leaves a quarter of it, each way, on the display nearest its centre", () => {
    const shown = { x: 1400, y: 600, ...size };
    expect(keepShown(shown, [laptopDisplay])).toEqual(shown);
    expect(keepShown({ x: 1480, y: 900, ...size }, [laptopDisplay])).toEqual({
      x: 1512 - 51,
      y: 982 - 120,
      ...size,
    });
    expect(keepShown({ x: -500, y: -600, ...size }, [laptopDisplay])).toEqual({
      x: -202 + 51,
      y: -480 + 120,
      ...size,
    });
  });

  test("a drag moves her by the pointer's travel, past a display's edge until a quarter of her shows", () => {
    const start = { window: { x: 1000, y: 300, ...size }, pointer: { x: 1100, y: 500 } };
    expect(dragged(start, { x: 1040, y: 460 }, [laptopDisplay])).toEqual({
      x: 940,
      y: 260,
      ...size,
    });
    // 112 of her 202 DIP past the right edge, the rest showing.
    expect(dragged(start, { x: 1500, y: 500 }, [laptopDisplay])).toEqual({
      x: 1400,
      y: 300,
      ...size,
    });
    expect(dragged(start, { x: 1900, y: 500 }, [laptopDisplay])).toEqual({
      x: 1512 - 51,
      y: 300,
      ...size,
    });
  });

  test("a drag crosses onto the next display with the pointer, and is kept shown on the display under it", () => {
    const displays = [laptopDisplay, externalDisplay];
    const start = { window: { x: 1000, y: 300, ...size }, pointer: { x: 1100, y: 500 } };
    expect(dragged(start, { x: 2200, y: 500 }, displays)).toEqual({ x: 2100, y: 300, ...size });
    // Held by her head, down to the external display's bottom edge: a quarter of her stays on it.
    const held = { window: { x: 2100, y: 300, ...size }, pointer: { x: 2200, y: 310 } };
    expect(dragged(held, { x: 2200, y: 1214 }, displays)).toEqual({
      x: 2100,
      y: 1215 - 120,
      ...size,
    });
  });

  test("a drop within SNAP_DIP of the work area's bottom stands her on it; farther, where it fell", () => {
    const bottom = laptop.y + laptop.height;
    const near = { x: 500, y: bottom - 20 - size.height, ...size };
    expect(settled(near, [laptop], [laptopDisplay])).toEqual({ ...near, y: bottom - size.height });
    const far = { x: 500, y: bottom - 30 - size.height, ...size };
    expect(settled(far, [laptop], [laptopDisplay])).toEqual(far);
    // Past the Dock, half of her below the display's bottom: where it fell.
    const below = { x: 500, y: 982 - 240, ...size };
    expect(settled(below, [laptop], [laptopDisplay])).toEqual(below);
  });
});

describe("her window's options", () => {
  const common = {
    show: false,
    title: "LAPLACE Eidolon",
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      additionalArguments: [COMPANION_SWITCH],
    },
  };

  test("macOS: transparent, frameless, never focused, taking a first click, out of Mission Control, on top on every Space", () => {
    expect(companionWindowSetup("darwin", false)).toEqual({
      options: { ...common, acceptFirstMouse: true, hiddenInMissionControl: true },
      floats: true,
      allSpaces: true,
      forwards: true,
    });
  });

  test("Windows: the same window without macOS's keys, on top, its passed clicks forwarding the mouse's moves", () => {
    expect(companionWindowSetup("win32", false)).toEqual({
      options: common,
      floats: true,
      allSpaces: false,
      forwards: true,
    });
  });

  test("background mode: never on top, on every Space or forwarding the mouse's moves", () => {
    expect(companionWindowSetup("darwin", true)).toEqual({
      options: { ...common, acceptFirstMouse: true, hiddenInMissionControl: true },
      floats: false,
      allSpaces: false,
      forwards: false,
    });
    expect(companionWindowSetup("win32", true)).toEqual({
      options: common,
      floats: false,
      allSpaces: false,
      forwards: false,
    });
  });
});

describe("menuLabel", () => {
  test("an owner's name reads as one clean line", () => {
    expect(menuLabel("Milky\tGreen\u202e\n v2")).toBe("Milky Green v2");
    expect(menuLabel(" 奶绿\u2028夏装\u2029 ")).toBe("奶绿 夏装");
  });

  test("clipped to LABEL_CHARS characters with an ellipsis", () => {
    const name = "a".repeat(50);
    expect(LABEL_CHARS).toBe(40);
    expect(menuLabel(name)).toBe(`${"a".repeat(40)}…`);
    expect(menuLabel("a".repeat(40))).toBe("a".repeat(40));
    expect([...menuLabel("绿".repeat(45))]).toHaveLength(41);
  });

  test("& doubled, which Windows' menus and Electron's macOS ones both show as one", () => {
    expect(menuLabel("A & B")).toBe("A && B");
    expect(menuLabel("A && B")).toBe("A &&&& B");
    // macOS drops a "(&x)" group as it would on Windows, so "(&&)" keeps a zero-width space inside.
    expect(menuLabel("Rock (&) Roll")).toBe("Rock (\u200b&&) Roll");
  });

  test("a name with nothing to show reads as a dash", () => {
    expect(menuLabel("\u200b")).toBe("—");
    expect(menuLabel("")).toBe("—");
    expect(menuLabel(" \t ")).toBe("—");
  });
});

test("her log lines never read as the main window's, which the smokes match as substrings", () => {
  const lines = [
    ...Object.values(COMPANION_LINES).filter((line) => typeof line === "string"),
    COMPANION_LINES.drawn("model"),
    COMPANION_LINES.drawn("picture"),
    COMPANION_LINES.failed("ERR_FAILED (-2) loading eidolon-app://app/companion"),
    companionLine(true, false),
    companionLine(true, true),
    companionLine(false, false),
    companionLine(false, true),
  ];
  expect(lines).toHaveLength(20);
  for (const line of lines) {
    for (const main of ["the window shows", "the window is shown", "the window is hidden"]) {
      expect(line).not.toContain(main);
    }
  }
  expect(companionLine(true, false)).toBe(COMPANION_LINES.shown);
  expect(companionLine(true, true)).toBe(COMPANION_LINES.offScreen);
  expect(companionLine(false, false)).toBe(COMPANION_LINES.hidden);
  expect(companionLine(false, true)).toBe(COMPANION_LINES.hidden);
});
