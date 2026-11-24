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

/** A chat's or a task's id, as the server makes them: a lowercase UUID. */
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * What the menus and the notifications ask of the app's page; apps/web ignores one it doesn't
 * know. `open-task:<chat>:<task>` opens a task in its chat (openTaskCommand).
 */
export type DesktopCommand = "settings" | "tasks" | `open-task:${string}:${string}`;

/** The command that opens `task` in `chat`; throws unless both are ids. */
export function openTaskCommand(chat: string, task: string): `open-task:${string}:${string}` {
  if (!ID_PATTERN.test(chat) || !ID_PATTERN.test(task)) {
    throw new Error("opening a task takes a chat's id and a task's");
  }
  return `open-task:${chat}:${task}`;
}

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
   * App page → main, with nothing: the page listens for commands now, so main sends it one held
   * while it loaded.
   */
  takesCommands: "eidolon:takes-commands",
  /** App page → main, invoked with nothing: the folder the native dialog picked, or null. */
  chooseFolder: "eidolon:choose-folder",
  /** App page → main, invoked with nothing: Open at Login's LoginItemState. */
  loginItem: "eidolon:login-item",
  /** App page → main, invoked with a boolean: Open at Login on or off, then its LoginItemState. */
  setLoginItem: "eidolon:set-login-item",
  /** App page → main, invoked with nothing: the terminal command's CommandState. */
  terminalCommand: "eidolon:terminal-command",
  /** App page → main, invoked with a CommandAction: the CommandChange. */
  setTerminalCommand: "eidolon:set-terminal-command",
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
  [BRIDGE.takesCommands]: "app",
  [BRIDGE.chooseFolder]: "app",
  [BRIDGE.loginItem]: "app",
  [BRIDGE.setLoginItem]: "app",
  [BRIDGE.terminalCommand]: "app",
  [BRIDGE.setTerminalCommand]: "app",
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

/** Main's answer on BRIDGE.chooseFolder: the folder, or null when it sent anything else. */
export function folderOf(answer: unknown): string | null {
  return typeof answer === "string" ? answer : null;
}

/** Why a desktop option can't be used in this copy of the app. */
export type Unavailable = "background" | "unpackaged" | "outside-applications" | "not-installed";

export type LoginItemState =
  | { readonly state: "unavailable"; readonly reason: Unavailable }
  | { readonly state: "on" }
  | { readonly state: "off" }
  /** macOS: registered, but turned off in System Settings → General → Login Items. */
  | { readonly state: "needs-approval" };

export type CommandState =
  | { readonly state: "unavailable"; readonly reason: Unavailable }
  /** Not installed: `path` is where Install puts it (the link on macOS, the PATH folder on Windows). */
  | { readonly state: "absent"; readonly path: string }
  | { readonly state: "installed"; readonly path: string }
  /** Something else is at `path`: Install refuses rather than replace it. macOS only. */
  | { readonly state: "taken"; readonly path: string };

export interface CommandChange {
  readonly command: CommandState;
  /** Why nothing changed: the owner cancelled macOS's password prompt, or it failed (main.log says why). */
  readonly error?: "cancelled" | "failed";
}

const COMMAND_ACTIONS = ["install", "remove"] as const;
/** What BRIDGE.setTerminalCommand does to the terminal command. */
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

export function isCommandAction(value: unknown): value is CommandAction {
  return (COMMAND_ACTIONS as readonly unknown[]).includes(value);
}

const UNAVAILABLE: readonly unknown[] = [
  "background",
  "unpackaged",
  "outside-applications",
  "not-installed",
] satisfies readonly Unavailable[];

interface UnavailableState {
  readonly state: "unavailable";
  readonly reason: Unavailable;
}

/** What the page is told when main's answer has another shape. */
function malformed(): UnavailableState {
  return { state: "unavailable", reason: "unpackaged" };
}

function fields(answer: unknown): Partial<Record<string, unknown>> {
  return (answer ?? {}) as Partial<Record<string, unknown>>;
}

function unavailableOf(state: unknown, reason: unknown): UnavailableState | null {
  return state === "unavailable" && UNAVAILABLE.includes(reason)
    ? { state, reason: reason as Unavailable }
    : null;
}

/** Main's answer on BRIDGE.loginItem and setLoginItem, or an unpackaged copy's when malformed. */
export function loginItemStateOf(answer: unknown): LoginItemState {
  const { state, reason } = fields(answer);
  if (state === "on" || state === "off" || state === "needs-approval") return { state };
  return unavailableOf(state, reason) ?? malformed();
}

function commandStateOrNull(answer: unknown): CommandState | null {
  const { state, reason, path } = fields(answer);
  const placed = state === "absent" || state === "installed" || state === "taken";
  if (placed && typeof path === "string") return { state, path };
  return unavailableOf(state, reason);
}

/** Main's answer on BRIDGE.terminalCommand, or an unpackaged copy's when malformed. */
export function commandStateOf(answer: unknown): CommandState {
  return commandStateOrNull(answer) ?? malformed();
}

/** Main's answer on BRIDGE.setTerminalCommand; a malformed one failed, on an unpackaged copy. */
export function commandChangeOf(answer: unknown): CommandChange {
  const { command, error } = fields(answer);
  const state = commandStateOrNull(command);
  if (state !== null && error === undefined) return { command: state };
  if (state !== null && (error === "cancelled" || error === "failed")) {
    return { command: state, error };
  }
  return { command: malformed(), error: "failed" };
}

/** `window.eidolonDesktop`, on the app's page alone (docs/web-app.md, "In the desktop app"). */
export interface EidolonDesktop {
  /** Node's name for the OS: "darwin" or "win32". */
  readonly platform: string;
  readonly version: string;
  readonly serverVersion: string;
  readonly setTheme: (setting: ThemeSetting) => void;
  readonly setLanguage: (language: Language) => void;
  /** Hands `callback` each command the menus and the notifications send, such as "settings". */
  readonly onCommand: (callback: (command: string) => void) => void;
  /** The native folder dialog: the folder picked, or null when cancelled. */
  readonly chooseFolder: () => Promise<string | null>;
  /** Open at Login, as the OS has it. */
  readonly loginItem: () => Promise<LoginItemState>;
  /** Turns Open at Login on or off; then the state as the OS has it. */
  readonly setLoginItem: (on: boolean) => Promise<LoginItemState>;
  /** The `eidolon` command for terminals. */
  readonly terminalCommand: () => Promise<CommandState>;
  readonly setTerminalCommand: (action: "install" | "remove") => Promise<CommandChange>;
}

/** `window.eidolonShell`, on the shell pages alone: the failure page's buttons. */
export interface EidolonShell {
  readonly retry: () => void;
  readonly showLogs: () => void;
  readonly quit: () => void;
}
