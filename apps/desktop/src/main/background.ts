// Background mode, for test runs on a machine its owner is working on: the app puts no window,
// dialog or prompt in front of them and never takes the focus. EIDOLON_DESKTOP_BACKGROUND in the
// launch environment turns it on, packaged or not. Electron-free: instance.ts reads it, native.ts
// puts Electron's calls through it, and the window, the menus and the permissions follow it.
import { basename, extname, join } from "node:path";
import type {
  AboutPanelOptionsOptions,
  MenuItemConstructorOptions,
  MessageBoxOptions,
  PopupOptions,
} from "electron";
import { launchFlag } from "./environment.ts";
import { loggedUrl } from "./policy.ts";

/**
 * Chromium's capture device that plays a file or a tone, which the smokes give a call. Chromium's
 * --use-fake-ui-for-media-stream answers a request itself, past the session's permission handler:
 * a run with that switch gets the camera too.
 */
export const FAKE_MEDIA_DEVICE = "use-fake-device-for-media-stream";
/** Chromium's switch that sends no page's sound to the speakers. */
export const MUTE_AUDIO = "mute-audio";
/** In the profile: where background mode saves downloads. */
export const DOWNLOADS_FOLDER = "downloads";
/** main.log's line once background mode is on. */
export const BACKGROUND_LINE = `Eidolon: background mode: nothing shows on screen or takes the focus, and nothing is heard (--${MUTE_AUDIO})`;

interface Log {
  info(message: string): void;
}

/** EIDOLON_DESKTOP_BACKGROUND in the launch environment, off unless set on. */
export function backgroundMode(
  launch: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return launchFlag(launch, "EIDOLON_DESKTOP_BACKGROUND", false, platform);
}

/** macOS's accessory policy: no Dock icon, and never made the active app. */
export function activationPolicy(
  platform: NodeJS.Platform,
  background: boolean,
): "accessory" | null {
  return background && platform === "darwin" ? "accessory" : null;
}

/**
 * Chromium's switches to set before ready: mute-audio, so a call's reply never plays through the
 * owner's speakers. WebRTC still receives it.
 */
export function chromiumSwitches(background: boolean): readonly string[] {
  return background ? [MUTE_AUDIO] : [];
}

/**
 * The port the backend's first spawn asks for: in background mode a free one, never 7860, where the
 * owner's own Eidolon may be between two processes in a restart, and its supervisor ends when the
 * next one finds the port taken. Otherwise the controller's own.
 */
export function backendPort(background: boolean): number | undefined {
  return background ? 0 : undefined;
}

/** On Windows, background mode's window has no taskbar button. */
export function backgroundWindowOptions(
  platform: NodeJS.Platform,
  background: boolean,
): { readonly skipTaskbar?: true } {
  return background && platform === "win32" ? { skipTaskbar: true } : {};
}

/** Windows' notification-area icon, and with it the notice the first hide shows. */
export function hasTray(platform: NodeJS.Platform, background: boolean): boolean {
  return platform === "win32" && !background;
}

/** What bringing the window forward calls on it, in order. */
export type ShowCall = "maximize" | "restore" | "show" | "focus";

/**
 * Maximized at its first paint if it was, restored if minimized, then shown and focused. Background
 * mode calls none of them: maximize() shows a hidden window too.
 */
export function showCalls(
  background: boolean,
  window: { readonly minimized: boolean; readonly maximize: boolean },
): ShowCall[] {
  if (background) return [];
  return [
    ...(window.maximize ? (["maximize"] as const) : []),
    ...(window.minimized ? (["restore"] as const) : []),
    "show",
    "focus",
  ];
}

/**
 * The page's microphone once the policy grants it. Background mode never asks macOS, and only
 * Chromium's fake device may answer: a grant without it would record the owner.
 */
export function backgroundMicrophone(fakeDevice: boolean, log: Log): boolean {
  log.info(
    fakeDevice
      ? "Eidolon: background mode gave the page the microphone without asking macOS"
      : `Eidolon: background mode denied the page the microphone: only Chromium's fake device (--${FAKE_MEDIA_DEVICE}) may answer`,
  );
  return fakeDevice;
}

/**
 * Where background mode saves each download, which has no Save dialog: in its folder, under the
 * name Chromium suggests, numbered " (1)" on while a file has that name or a download given it
 * hasn't landed yet. Chromium writes the file only as a download ends.
 */
export class DownloadPaths {
  readonly #folder: string;
  readonly #exists: (path: string) => boolean;
  readonly #given = new Set<string>();

  constructor(folder: string, exists: (path: string) => boolean) {
    this.#folder = folder;
    this.#exists = exists;
  }

  next(suggested: string): string {
    const leaf = basename(suggested.replaceAll("\\", "/"));
    const name = leaf === "" || leaf === "." || leaf === ".." ? "download" : leaf;
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    let path = join(this.#folder, name);
    for (let n = 1; this.#given.has(path) || this.#exists(path); n++) {
      path = join(this.#folder, `${stem} (${n})${extension}`);
    }
    this.#given.add(path);
    return path;
  }
}

export interface MessageBoxAnswer {
  readonly response: number;
  readonly checkboxChecked: boolean;
}

/**
 * The calls into Electron that could put something in front of the owner. Chromium opens a file
 * input's chooser, a date field's calendar and a datalist's suggestions with none of them, and
 * Electron gives main no hook on those.
 */
export interface NativeUi {
  messageBox(box: MessageBoxOptions): Promise<MessageBoxAnswer>;
  openExternal(url: string): Promise<void>;
  /** Resolves to the error, empty once it opened. */
  openPath(path: string): Promise<string>;
  aboutPanel(panel: AboutPanelOptionsOptions): void;
  /** Makes the app active, over whichever app is. */
  stealFocus(): void;
  popup(menu: readonly MenuItemConstructorOptions[], options: PopupOptions): void;
}

function labels(menu: readonly MenuItemConstructorOptions[]): string {
  return menu
    .flatMap((item) => (item.type === "separator" ? [] : [item.label ?? item.role ?? ""]))
    .join(", ");
}

/**
 * `electron` as it is, or in background mode calls that log what they would have shown and answer
 * as the owner taking the defaults would: a message box its default button.
 */
export function nativeUi(background: boolean, electron: NativeUi, log: Log): NativeUi {
  if (!background) return electron;
  return {
    async messageBox(box) {
      const response = box.defaultId ?? 0;
      const button = box.buttons?.[response] ?? "OK";
      const text = [box.message, box.detail].filter(Boolean).join(" ");
      log.info(`Eidolon: background mode answered "${button}" to a message box: ${text}`);
      return { response, checkboxChecked: box.checkboxChecked ?? false };
    },
    async openExternal(url) {
      log.info(`Eidolon: background mode didn't open ${loggedUrl(url)} in the default browser`);
    },
    async openPath(path) {
      log.info(`Eidolon: background mode didn't open ${path}`);
      return "";
    },
    aboutPanel({ applicationName, applicationVersion, version, credits }) {
      const server = version || credits;
      log.info(
        `Eidolon: background mode didn't show the About panel: ${applicationName} ${applicationVersion}${server ? ` (${server})` : ""}`,
      );
    },
    stealFocus() {},
    popup(menu) {
      log.info(`Eidolon: background mode didn't open a menu: ${labels(menu)}`);
    },
  };
}
