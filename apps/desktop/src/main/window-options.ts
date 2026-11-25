// The window's options: its chrome on each platform, and its bounds, kept in a JSON file
// in userData across launches. Electron-free: window.ts and chrome.ts apply them.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from "electron";

export const DEFAULT_SIZE = { width: 1280, height: 820 } as const;
export const MIN_SIZE = { width: 520, height: 600 } as const;
/** In userData. */
export const BOUNDS_FILE = "window-bounds.json";

/** apps/web's title strip, 2.75rem: the row the traffic lights sit on, and the caption buttons' height. */
export const STRIP_PX = 44;
/** The traffic lights' height as macOS 27 draws them: the overlay's area is 2y + 14 px tall. */
const TRAFFIC_LIGHTS_PX = 14;

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

/**
 * Whether the file keeps the window maximized: as it was read while the saved maximize waits for
 * the window's first showing, which a hidden start puts off, and in background mode, which never
 * maximizes the window; else as the window is.
 */
export function keptMaximized(
  background: boolean,
  window: { readonly saved: boolean; readonly waiting: boolean; readonly maximized: boolean },
): boolean {
  return background || window.waiting ? window.saved : window.maximized;
}

function overlap(a: Rectangle, b: Rectangle): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** A display's id and work area, as Electron's screen gives them. */
export interface DisplayArea {
  readonly id: number;
  readonly workArea: Rectangle;
}

/** The displays' work areas, the primary's first: Electron centres a window with no position there. */
export function workAreas(primary: DisplayArea, displays: readonly DisplayArea[]): Rectangle[] {
  return [primary, ...displays.filter((display) => display.id !== primary.id)].map(
    (display) => display.workArea,
  );
}

/** `size` cut to `area`'s, where there is one, and never below the minimum. */
function fitted(
  size: { readonly width: number; readonly height: number },
  area: Rectangle | undefined,
): { width: number; height: number } {
  return {
    width: Math.max(MIN_SIZE.width, area ? Math.min(size.width, area.width) : size.width),
    height: Math.max(MIN_SIZE.height, area ? Math.min(size.height, area.height) : size.height),
  };
}

/**
 * Where the window opens: the saved bounds while a display still shows enough of its top to drag it
 * by, else centred at the saved size, or at the default size the first time. Its size fits the
 * display it lands on, the first of `areas` when it is centred, and is never below the minimum.
 */
export function placement(saved: SavedBounds | null, areas: readonly Rectangle[]): Placement {
  if (saved === null) return { ...fitted(DEFAULT_SIZE, areas[0]), maximized: false };
  const strip = { x: saved.x, y: saved.y, width: saved.width, height: VISIBLE_STRIP.height };
  const area = areas.find((candidate) => {
    const shown = overlap(strip, candidate);
    return shown.width >= VISIBLE_STRIP.width && shown.height >= VISIBLE_STRIP.height;
  });
  const size = fitted(saved, area ?? areas[0]);
  return area === undefined
    ? { ...size, maximized: saved.maximized }
    : { x: saved.x, y: saved.y, ...size, maximized: saved.maximized };
}

/** The caption buttons' glyphs, which Windows draws in the colour it's given. */
export function symbolColor(dark: boolean): string {
  return dark ? "#ffffff" : "#1f1f1f";
}

/** Windows' caption buttons over the page, which draws its own bar beneath them. */
export function titleBarOverlay(dark: boolean): TitleBarOverlayOptions {
  return { color: "#00000000", symbolColor: symbolColor(dark), height: STRIP_PX };
}

/** No system title bar: the page's strip stands in for it, around the window's own buttons. */
export function chromeOptions(
  platform: NodeJS.Platform,
  dark: boolean,
): BrowserWindowConstructorOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: (STRIP_PX - TRAFFIC_LIGHTS_PX) / 2 },
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
