// The bridges between the window's pages and main: the IPC channels, what each carries, and which
// page may use it. The sandboxed preload bundles it too, so it imports nothing.

export const SCHEME = "eidolon-app";

/** The window's two kinds of page: the app's own, from the backend, and the shell's. */
export type Page = "app" | "shell";

/**
 * Which page a frame at `url` shows, by protocol and host: Node's URL gives a custom scheme's
 * origin as "null". A waiting page served in place at the app's address is the app's.
 */
export function pageAt(url: string): Page | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${SCHEME}:`) return null;
  if (parsed.host === "app") return "app";
  if (parsed.host === "shell") return "shell";
  return null;
}

export const THEME_SETTINGS = ["light", "dark", "system"] as const;
/** apps/web's theme setting, never the theme System resolves to. */
export type ThemeSetting = (typeof THEME_SETTINGS)[number];

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return (THEME_SETTINGS as readonly unknown[]).includes(value);
}

export const LANGUAGES = ["en", "zh-Hans"] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return (LANGUAGES as readonly unknown[]).includes(value);
}

/** What the menus ask of the app's page; apps/web ignores one it doesn't know. */
export type DesktopCommand = "settings";

/** The channels, each with what it carries and which way. */
export const BRIDGE = {
  /** App page → main: a ThemeSetting, for `nativeTheme.themeSource` as it is. */
  theme: "eidolon:theme",
  /** App page → main: the page's Language, for the shell's own strings. */
  language: "eidolon:language",
  /**
   * App page → main, synchronous: the DesktopVersions, which the preload needs before the page's
   * first script, and the server's only once the backend has answered.
   */
  versions: "eidolon:versions",
  /** Main → app page: a DesktopCommand. */
  command: "eidolon:command",
  /**
   * Main → any page, on macOS: whether the window is fullscreen, on entering and leaving it and
   * after each navigation, since a new page starts without the mark.
   */
  fullscreen: "eidolon:fullscreen",
  /** Shell page → main, with nothing: the failure page's buttons. */
  retry: "eidolon:retry",
  showLogs: "eidolon:show-logs",
  quit: "eidolon:quit",
} as const;

/** The channels main listens on, each with the one page whose main frame may send on it. */
const SENDERS = {
  [BRIDGE.theme]: "app",
  [BRIDGE.language]: "app",
  [BRIDGE.versions]: "app",
  [BRIDGE.retry]: "shell",
  [BRIDGE.showLogs]: "shell",
  [BRIDGE.quit]: "shell",
} as const satisfies Record<string, Page>;

export type PageChannel = keyof typeof SENDERS;

/** Who sent an IPC message, as main sees it on the event. */
export interface IpcSender {
  /** Whether it came from the app window's own webContents. */
  readonly window: boolean;
  /** Whether it came from that window's main frame. */
  readonly mainFrame: boolean;
  /**
   * The sending frame's origin, not its URL: a sandboxed document the backend serves has an app
   * URL and an opaque origin, "null". Null once the frame is gone.
   */
  readonly origin: string | null;
}

/**
 * Whether main takes a message on `channel` from `sender`: only from the channel's page, in the
 * app window's main frame.
 */
export function accepts(channel: PageChannel, sender: IpcSender): boolean {
  return (
    sender.window &&
    sender.mainFrame &&
    sender.origin !== null &&
    pageAt(sender.origin) === SENDERS[channel]
  );
}

/** The desktop app's version and that of the server it shows, which may be a terminal's. */
export interface DesktopVersions {
  readonly version: string;
  readonly serverVersion: string;
}

/** Main's answer on BRIDGE.versions, or empty versions when it sent something else. */
export function versionsOf(answer: unknown): DesktopVersions {
  const { version, serverVersion } = (answer ?? {}) as Partial<Record<string, unknown>>;
  return {
    version: typeof version === "string" ? version : "",
    serverVersion: typeof serverVersion === "string" ? serverVersion : "",
  };
}

/** `window.eidolonDesktop`, on the app's page alone (docs/web-app.md, "In the desktop app"). */
export interface EidolonDesktop {
  /** Node's name for the OS: "darwin" or "win32". */
  readonly platform: string;
  readonly version: string;
  readonly serverVersion: string;
  readonly setTheme: (setting: ThemeSetting) => void;
  readonly setLanguage: (language: Language) => void;
  /** Hands `callback` each command the menus send, such as "settings". */
  readonly onCommand: (callback: (command: string) => void) => void;
}

/** `window.eidolonShell`, on the shell pages alone: the failure page's buttons. */
export interface EidolonShell {
  readonly retry: () => void;
  readonly showLogs: () => void;
  readonly quit: () => void;
}
