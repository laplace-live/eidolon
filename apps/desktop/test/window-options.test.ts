// The window's options: its bounds file in userData, where it opens on today's displays, and its
// chrome on each platform.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backgroundColor,
  chromeOptions,
  DEFAULT_SIZE,
  keptMaximized,
  MIN_SIZE,
  placement,
  readBounds,
  type SavedBounds,
  STRIP_PX,
  symbolColor,
  titleBarOverlay,
  workAreas,
  writeBounds,
} from "../src/main/window-options.ts";

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "eidolon-window-options-"));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe("the bounds file", () => {
  test("keeps the bounds and whether the window was maximized, across a write and a read", () => {
    const file = join(folder, "profile", "window-bounds.json");
    const bounds: SavedBounds = { x: 120, y: 80, width: 1100, height: 760, maximized: true };
    writeBounds(file, bounds);
    expect(readBounds(file)).toEqual(bounds);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(bounds);
  });

  test("is no bounds when missing, unreadable or not a window's", () => {
    const file = join(folder, "window-bounds.json");
    expect(readBounds(file)).toBeNull();
    for (const text of [
      "",
      "{",
      "null",
      "[]",
      '"x"',
      '{"x":1,"y":2,"width":3}',
      '{"x":"1","y":2,"width":3,"height":4}',
      '{"x":1,"y":2,"width":0,"height":4}',
      '{"x":1,"y":2,"width":-3,"height":4}',
      '{"x":1e999,"y":2,"width":3,"height":4}',
    ]) {
      writeFileSync(file, text);
      expect([text, readBounds(file)]).toEqual([text, null]);
    }
    writeFileSync(file, '{"x":1,"y":2,"width":3,"height":4,"maximized":"yes"}');
    expect(readBounds(file)).toEqual({ x: 1, y: 2, width: 3, height: 4, maximized: false });
  });

  test("keeps a saved maximize the window's first showing has yet to apply, as at a quit from a hidden start", () => {
    expect(keptMaximized(false, { saved: true, waiting: true, maximized: false })).toBe(true);
  });

  test("after that showing, keeps whether the window is maximized", () => {
    expect(keptMaximized(false, { saved: true, waiting: false, maximized: false })).toBe(false);
    expect(keptMaximized(false, { saved: true, waiting: false, maximized: true })).toBe(true);
    expect(keptMaximized(false, { saved: false, waiting: false, maximized: true })).toBe(true);
    expect(keptMaximized(false, { saved: false, waiting: false, maximized: false })).toBe(false);
  });

  test("background mode, which never maximizes the window, keeps the flag as it was read", () => {
    expect(keptMaximized(true, { saved: true, waiting: false, maximized: false })).toBe(true);
    expect(keptMaximized(true, { saved: false, waiting: false, maximized: false })).toBe(false);
  });
});

describe("where the window opens", () => {
  const laptop = { x: 0, y: 25, width: 1512, height: 920 };
  const external = { x: 1512, y: -200, width: 2560, height: 1415 };

  test("the first time, centred at the default size, as much of it as the first work area holds", () => {
    expect(placement(null, [laptop])).toEqual({ ...DEFAULT_SIZE, maximized: false });
    // A 1366×768 laptop under Windows' taskbar, beside a larger display.
    const small = { x: 0, y: 0, width: 1366, height: 728 };
    expect(placement(null, [small, external])).toEqual({
      width: 1280,
      height: 728,
      maximized: false,
    });
    const tiny = { x: 0, y: 0, width: 480, height: 360 };
    expect(placement(null, [tiny])).toEqual({ ...MIN_SIZE, maximized: false });
    expect(placement(null, [])).toEqual({ ...DEFAULT_SIZE, maximized: false });
  });

  test("looks at the primary display's work area first, where a window with no position is centred", () => {
    const primary = { id: 2, workArea: laptop };
    expect(workAreas(primary, [{ id: 1, workArea: external }, primary])).toEqual([
      laptop,
      external,
    ]);
    expect(workAreas(primary, [primary])).toEqual([laptop]);
  });

  test("where it was, on whichever display still shows its top", () => {
    const saved = { x: 1700, y: 0, width: 1400, height: 900, maximized: false };
    expect(placement(saved, [laptop, external])).toEqual(saved);
    expect(placement({ ...saved, maximized: true }, [laptop, external]).maximized).toBe(true);
  });

  test("centred at its size once no display shows enough of its top to drag it by", () => {
    const saved = { x: 1700, y: 0, width: 1400, height: 900, maximized: false };
    expect(placement(saved, [laptop])).toEqual({ width: 1400, height: 900, maximized: false });
    // Only 60 px of its top on the laptop's right edge.
    const edge = { x: 1452, y: 100, width: 1000, height: 700, maximized: false };
    expect(placement(edge, [laptop])).toEqual({ width: 1000, height: 700, maximized: false });
    // Its top above the display, the rest below.
    const above = { x: 100, y: -500, width: 1000, height: 700, maximized: false };
    expect(placement(above, [laptop]).x).toBeUndefined();
  });

  test("never bigger than the display it lands on, nor smaller than the minimum", () => {
    const huge = { x: 0, y: 25, width: 4000, height: 3000, maximized: false };
    expect(placement(huge, [laptop])).toMatchObject({ width: 1512, height: 920 });
    const tiny = { x: 10, y: 30, width: 200, height: 100, maximized: false };
    expect(placement(tiny, [laptop])).toMatchObject({ x: 10, y: 30, ...MIN_SIZE });
    expect(placement(huge, [])).toMatchObject({ width: 4000, height: 3000 });
  });
});

describe("the chrome", () => {
  test("apps/web's strip and the shell pages' are as tall as main makes the window's buttons' row", () => {
    const strip = (file: string): number => {
      const css = readFileSync(join(import.meta.dirname, "../..", file), "utf8");
      return Number(/--strip: max\(([\d.]+)rem,/.exec(css)?.[1]) * 16;
    };
    expect(STRIP_PX).toBe(44);
    expect(strip("web/src/index.css")).toBe(STRIP_PX);
    expect(strip("desktop/src/shell/shell.css")).toBe(STRIP_PX);
  });

  test("macOS: the traffic lights inset and centred on the page's 44 px strip, with the overlay on", () => {
    expect(chromeOptions("darwin", false)).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 15 },
      titleBarOverlay: true,
    });
    expect(chromeOptions("darwin", true)).toEqual(chromeOptions("darwin", false));
  });

  test("Windows: no title bar, the caption buttons over a transparent 44 px overlay in the theme's glyphs", () => {
    expect(chromeOptions("win32", false)).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#00000000", symbolColor: "#1f1f1f", height: 44 },
    });
    expect(titleBarOverlay(true)).toEqual({
      color: "#00000000",
      symbolColor: "#ffffff",
      height: 44,
    });
    expect(symbolColor(false)).not.toBe(symbolColor(true));
  });

  test("the window's own colour is apps/web's background, so nothing flashes behind the page", () => {
    expect(backgroundColor(false)).toBe("#ffffff");
    expect(backgroundColor(true)).toBe("#0a0a0a");
  });
});
