// The desktop companion's settings, sizes and place on the displays, and the lines main logs of
// her. Electron-free: companion-flow.ts decides with it, companion-window.ts applies it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";
import {
  COMPANION_SWITCH,
  type CompanionDrawn,
  type CompanionShape,
  type CompanionSize,
  isCompanionSize,
  type WindowSize,
} from "../shared/bridge.ts";
import type { Rectangle } from "./window-options.ts";

/** In userData, beside window-bounds.json. */
export const COMPANION_FILE = "companion.json";
/** Her window's height, in DIP, by size; her picture's side. */
export const MODEL_HEIGHTS: Readonly<Record<CompanionSize, number>> = {
  small: 360,
  medium: 480,
  large: 640,
};
export const PICTURE_SIDES: Readonly<Record<CompanionSize, number>> = {
  small: 96,
  medium: 128,
  large: 160,
};
/** Her framing's width over its height until her page says: a full-length figure's. */
export const DEFAULT_ASPECT = 0.42;
/** Her first place: this far in from the primary work area's right edge, on its bottom. */
export const EDGE_DIP = 24;
/** A drop with her feet this near a work area's bottom stands her on it. */
export const SNAP_DIP = 24;
/** The most of a work area her window takes, each way. */
export const MAX_SHARE = 0.9;
/**
 * The least of her window, each way, a drag may leave on a display: she may stand partly off it,
 * but never so far that nothing of her is left to take hold of.
 */
export const MIN_SHOWN = 0.25;
export const DRAW_TIMEOUT_MS = 30_000;
export const POP_TIMEOUT_MS = 10_000;
export const CURSOR_MS = 33;
/** A menu item's click can come after the menu's close; the close waits this long for it. */
export const MENU_SETTLE_MS = 100;
export const RETRY_MS = 2_000;
/** The most of an owner's name a menu item shows. */
export const LABEL_CHARS = 40;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface CompanionSettings {
  readonly on: boolean;
  readonly showAtLogin: boolean;
  readonly alwaysOnTop: boolean;
  readonly size: CompanionSize;
  /** Where her feet were left: her window's bottom centre, in screen DIPs; null for her first place. */
  readonly feet: Point | null;
}

export const DEFAULT_COMPANION: CompanionSettings = {
  on: false,
  showAtLogin: true,
  alwaysOnTop: true,
  size: "medium",
  feet: null,
};

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** The file's settings, each field its default where missing or of another kind; all defaults with no file. */
export function readCompanion(file: string): CompanionSettings {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return DEFAULT_COMPANION;
  }
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return DEFAULT_COMPANION;
  const { on, showAtLogin, alwaysOnTop, size, feet } = saved as Partial<Record<string, unknown>>;
  const { x, y } = (typeof feet === "object" && feet !== null ? feet : {}) as Partial<
    Record<string, unknown>
  >;
  return {
    on: typeof on === "boolean" ? on : DEFAULT_COMPANION.on,
    showAtLogin: typeof showAtLogin === "boolean" ? showAtLogin : DEFAULT_COMPANION.showAtLogin,
    alwaysOnTop: typeof alwaysOnTop === "boolean" ? alwaysOnTop : DEFAULT_COMPANION.alwaysOnTop,
    size: isCompanionSize(size) ? size : DEFAULT_COMPANION.size,
    feet: isNumber(x) && isNumber(y) ? { x, y } : null,
  };
}

/** Through a temporary file, so a crash mid-write leaves the last settings whole. */
export function writeCompanion(file: string, settings: CompanionSettings): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  const { on, showAtLogin, alwaysOnTop, size, feet } = settings;
  const kept = { on, showAtLogin, alwaysOnTop, size, feet: feet && { x: feet.x, y: feet.y } };
  writeFileSync(temporary, `${JSON.stringify(kept)}\n`);
  renameSync(temporary, file);
}

/** Her window's size for `size` and `shape`, at most MAX_SHARE of `area` each way, scaled as one. */
export function companionSize(
  size: CompanionSize,
  shape: CompanionShape,
  area: Rectangle,
): WindowSize {
  const height = shape.kind === "model" ? MODEL_HEIGHTS[size] : PICTURE_SIDES[size];
  const width = shape.kind === "model" ? height * shape.aspect : height;
  const scale = Math.min(1, (MAX_SHARE * area.height) / height, (MAX_SHARE * area.width) / width);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Whether `rect` holds `point`, its right and bottom edges included: her feet stand on its bottom. */
function holds(rect: Rectangle, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function distance(area: Rectangle, point: Point): number {
  const dx = Math.max(area.x - point.x, 0, point.x - (area.x + area.width));
  const dy = Math.max(area.y - point.y, 0, point.y - (area.y + area.height));
  return Math.hypot(dx, dy);
}

/** The one of `areas` (work areas or displays) holding `point`, its right and bottom edges included, else the nearest; `areas` is never empty. */
export function areaAt(point: Point, areas: readonly Rectangle[]): Rectangle {
  const holding = areas.find((area) => holds(area, point));
  if (holding !== undefined) return holding;
  return areas.reduce((nearest, area) =>
    distance(area, point) < distance(nearest, point) ? area : nearest,
  );
}

/** Her window of `size` standing on `feet`. */
function windowAt(feet: Point, size: WindowSize): Rectangle {
  return {
    x: Math.round(feet.x - size.width / 2),
    y: Math.round(feet.y - size.height),
    width: size.width,
    height: size.height,
  };
}

/** How much of `rect` lies on `display`, each way, as a share of its width and its height. */
function shownOn(rect: Rectangle, display: Rectangle): { readonly x: number; readonly y: number } {
  const across =
    Math.min(rect.x + rect.width, display.x + display.width) - Math.max(rect.x, display.x);
  const down =
    Math.min(rect.y + rect.height, display.y + display.height) - Math.max(rect.y, display.y);
  return { x: Math.max(0, across) / rect.width, y: Math.max(0, down) / rect.height };
}

/** Whether MIN_SHOWN of `rect`, each way, lies on one of `displays` (their bounds). */
export function reachable(rect: Rectangle, displays: readonly Rectangle[]): boolean {
  return displays.some((display) => {
    const shown = shownOn(rect, display);
    return shown.x >= MIN_SHOWN && shown.y >= MIN_SHOWN;
  });
}

/** Where her window of `size` stands her: on `feet` while enough of it shows, else at her first place. */
export function standing(
  feet: Point | null,
  size: WindowSize,
  areas: readonly Rectangle[],
  displays: readonly Rectangle[],
): Point {
  if (feet !== null && reachable(windowAt(feet, size), displays)) return feet;
  const [primary] = areas;
  return {
    x: primary.x + primary.width - EDGE_DIP - size.width / 2,
    y: primary.y + primary.height,
  };
}

/** Her window of `size` standing where `standing` puts her feet. */
export function placement(
  feet: Point | null,
  size: WindowSize,
  areas: readonly Rectangle[],
  displays: readonly Rectangle[],
): Rectangle {
  return windowAt(standing(feet, size, areas, displays), size);
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(value, high));

/** The one of `displays` showing the most of `rect`, else the one nearest its centre. */
function displayOf(rect: Rectangle, displays: readonly Rectangle[]): Rectangle {
  let most: Rectangle | null = null;
  let shownMost = 0;
  for (const display of displays) {
    const shown = shownOn(rect, display);
    if (shown.x * shown.y > shownMost) {
      most = display;
      shownMost = shown.x * shown.y;
    }
  }
  return most ?? areaAt({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, displays);
}

/**
 * `rect` as it is while MIN_SHOWN of it, each way, shows on a display; else moved, never resized,
 * the least way that leaves that much of it on `home`, by default the display showing the most of it.
 */
export function keepShown(
  rect: Rectangle,
  displays: readonly Rectangle[],
  home: Rectangle = displayOf(rect, displays),
): Rectangle {
  if (reachable(rect, displays)) return rect;
  const across = Math.ceil(rect.width * MIN_SHOWN);
  const down = Math.ceil(rect.height * MIN_SHOWN);
  return {
    x: clamp(rect.x, home.x - rect.width + across, home.x + home.width - across),
    y: clamp(rect.y, home.y - rect.height + down, home.y + home.height - down),
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Her window as a drag leaves it: moved by the pointer's travel since the drag's start, kept shown on
 * the display it started on.
 */
export function dragged(
  start: { readonly window: Rectangle; readonly pointer: Point },
  pointer: Point,
  displays: readonly Rectangle[],
): Rectangle {
  return keepShown(
    {
      ...start.window,
      x: Math.round(start.window.x + pointer.x - start.pointer.x),
      y: Math.round(start.window.y + pointer.y - start.pointer.y),
    },
    displays,
    displayOf(start.window, displays),
  );
}

/** A drop: within SNAP_DIP of the work area's bottom, her feet on it; then kept shown. */
export function settled(
  rect: Rectangle,
  areas: readonly Rectangle[],
  displays: readonly Rectangle[],
): Rectangle {
  const area = areaAt({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, areas);
  const bottom = area.y + area.height;
  const near = Math.abs(bottom - (rect.y + rect.height)) <= SNAP_DIP;
  return keepShown(near ? { ...rect, y: bottom - rect.height } : rect, displays);
}

export function feetOf(rect: Rectangle): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
}

/** Her window's options and what main sets on it after, outside background mode only. */
export function companionWindowSetup(
  platform: NodeJS.Platform,
  background: boolean,
): {
  readonly options: BrowserWindowConstructorOptions;
  /** setAlwaysOnTop(alwaysOnTop, "floating") at each open and toggle. */
  readonly floats: boolean;
  /** setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true}). */
  readonly allSpaces: boolean;
  /** Passing clicks forwards the mouse's moves to her page ({forward: true}). */
  readonly forwards: boolean;
} {
  return {
    options: {
      show: false,
      title: "Eidolon",
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
      // A window never made active takes each click as a first click, which macOS keeps from the
      // page unless this is on.
      ...(platform === "darwin" ? { acceptFirstMouse: true, hiddenInMissionControl: true } : {}),
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        additionalArguments: [COMPANION_SWITCH],
      },
    },
    floats: !background,
    allSpaces: !background && platform === "darwin",
    // On Windows forwarding is a mouse hook on main's thread for every move on the machine; in
    // background mode the smoke drives her page with sendInputEvent, which needs none.
    forwards: !background,
  };
}

/** An owner's name for a menu item: one line, no control, format or separator characters, clipped, `&` doubled. */
export function menuLabel(name: string): string {
  const line = name
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...line];
  const clipped =
    chars.length > LABEL_CHARS ? `${chars.slice(0, LABEL_CHARS).join("").trimEnd()}…` : line;
  // Windows' menus read one & as an access key, and Electron's macOS ones drop it as Chromium's
  // FixUpWindowsStyleLabel does; both show && as one. That also drops a "(&x)" group, as "(&&)"
  // reads, which a zero-width space breaks.
  const label = clipped.replaceAll("&", "&&").replaceAll("(&&)", "(\u200b&&)");
  return label === "" ? "—" : label;
}

export const COMPANION_LINES = {
  on: "Eidolon: the desktop companion was turned on",
  off: "Eidolon: the desktop companion was turned off",
  shown: "Eidolon: the companion is shown",
  hidden: "Eidolon: the companion is hidden",
  offScreen: "Eidolon: background mode keeps the companion off screen",
  drawn: (kind: CompanionDrawn) => `Eidolon: the companion's page drew her ${kind}`,
  late: "Eidolon: the companion's page didn't draw her within 30 s",
  failed: (detail: string) => `Eidolon: the companion's page failed: ${detail}`,
  again: "Eidolon: loading the companion's page again",
  poppedOut: "Eidolon: popped out: the companion carries the call, and the window hides",
  popLate: "Eidolon: Pop Out left the window: the companion didn't draw within 10 s",
  unthrottled: "Eidolon: background throttling is off for the window while it feeds the companion",
  throttled: "Eidolon: background throttling is back on for the window",
  closed: "Eidolon: the companion's window is closed",
  placeReset: "Eidolon: the companion's place was reset to her first place",
} as const;

/** The line main logs as its record of her showing changes. */
export function companionLine(shown: boolean, background: boolean): string {
  if (!shown) return COMPANION_LINES.hidden;
  return background ? COMPANION_LINES.offScreen : COMPANION_LINES.shown;
}
