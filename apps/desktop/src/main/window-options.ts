// The window's options (§5.1, §5.2): its chrome on each platform, and its bounds, kept in a JSON file
// in userData across launches. Electron-free: window.ts and chrome.ts apply them.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from "electron";

export const DEFAULT_SIZE = { width: 1280, height: 820 } as const;
export const MIN_SIZE = { width: 520, height: 600 } as const;
/** In userData. */
export const BOUNDS_FILE = "window-bounds.json";

/** apps/web's header row, 3.5rem: the row the traffic lights sit on, and the caption buttons' height. */
export const HEADER_ROW_PX = 56;
const TRAFFIC_LIGHTS_PX = 16;

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the file keeps: the window's bounds out of maximized and fullscreen, and whether it was maximized. */
export interface SavedBounds extends Rectangle {
  readonly maximized: boolean;
}

/** The bounds to create the window with: no position when the saved one is off every display. */
export interface Placement {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
}

/** How much of the window's top must be on a display for it to stay where it was. */
const VISIBLE_STRIP = { width: 100, height: 40 } as const;

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The file's bounds, or null where there is none or it isn't a window's. */
export function readBounds(file: string): SavedBounds | null {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const { x, y, width, height, maximized } = (saved ?? {}) as Partial<Record<string, unknown>>;
  if (!isNumber(x) || !isNumber(y) || !isNumber(width) || !isNumber(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height, maximized: maximized === true };
}

/** Writes through a temporary file, so a crash mid-write leaves the last bounds whole. */
export function writeBounds(file: string, bounds: SavedBounds): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const { x, y, width, height, maximized } = bounds;
  writeFileSync(temporary, `${JSON.stringify({ x, y, width, height, maximized })}\n`);
  renameSync(temporary, file);
}

function overlap(a: Rectangle, b: Rectangle): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Where the window opens: the saved bounds while a display still shows enough of its top to drag it
 * by, else centred at the saved size. Its size fits the display it lands on, and is never below the
 * minimum.
 */
export function placement(saved: SavedBounds | null, workAreas: readonly Rectangle[]): Placement {
  if (saved === null) return { ...DEFAULT_SIZE, maximized: false };
  const strip = { x: saved.x, y: saved.y, width: saved.width, height: VISIBLE_STRIP.height };
  const area = workAreas.find((candidate) => {
    const shown = overlap(strip, candidate);
    return shown.width >= VISIBLE_STRIP.width && shown.height >= VISIBLE_STRIP.height;
  });
  const fit = area ?? workAreas[0];
  const width = Math.max(MIN_SIZE.width, fit ? Math.min(saved.width, fit.width) : saved.width);
  const height = Math.max(MIN_SIZE.height, fit ? Math.min(saved.height, fit.height) : saved.height);
  return area === undefined
    ? { width, height, maximized: saved.maximized }
    : { x: saved.x, y: saved.y, width, height, maximized: saved.maximized };
}

/** The caption buttons' glyphs, which Windows draws in the colour it's given. */
export function symbolColor(dark: boolean): string {
  return dark ? "#ffffff" : "#1f1f1f";
}

/** Windows' caption buttons over the page, which draws its own bar beneath them. */
export function titleBarOverlay(dark: boolean): TitleBarOverlayOptions {
  return { color: "#00000000", symbolColor: symbolColor(dark), height: HEADER_ROW_PX };
}

/** No system title bar (D6): the page's rows stand in for it, beside the window's own buttons. */
export function chromeOptions(
  platform: NodeJS.Platform,
  dark: boolean,
): BrowserWindowConstructorOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: (HEADER_ROW_PX - TRAFFIC_LIGHTS_PX) / 2 },
      // Without it macOS publishes no env(titlebar-area-*) for the page's insets.
      titleBarOverlay: true,
    };
  }
  return { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay(dark) };
}

/** apps/web's background, so nothing flashes white behind a dark page. */
export function backgroundColor(dark: boolean): string {
  return dark ? "#0a0a0a" : "#ffffff";
}
