// The desktop app's bridge: its preload puts `eidolonDesktop` on the app's own page, and a browser
// has none, so everything that differs in the desktop app asks `desktop()` first. The page can come
// from a server of another version than the app's, so a member added since the first release is
// optional, and asked for before it's used.
import { i18n } from "@lingui/core";
import type { Lang } from "@/locales/i18n";
import { onThemeChange, type Theme, themeSetting } from "./theme";

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

export interface EidolonDesktop {
  /** Node's name for the OS the app runs on: "darwin" or "win32". */
  readonly platform: string;
  /** The desktop app's own version, apart from the server's. */
  readonly version: string;
  /** The version of the server the app ships. */
  readonly serverVersion: string;
  /** The setting as chosen: a resolved theme would hold the window off the OS's under System. */
  readonly setTheme: (setting: Theme) => void;
  readonly setLanguage: (language: Lang) => void;
  /** Hands `callback` each command the app's menus and notifications send, such as `settings`. */
  readonly onCommand: (callback: (command: string) => void) => void;
  /** The native folder dialog: the folder picked, or null when cancelled. */
  readonly chooseFolder?: () => Promise<string | null>;
  /** Open at Login, as the OS has it. */
  readonly loginItem?: () => Promise<LoginItemState>;
  /** Turns Open at Login on or off; then the state as the OS has it. */
  readonly setLoginItem?: (on: boolean) => Promise<LoginItemState>;
  /** The `eidolon` command for terminals. */
  readonly terminalCommand?: () => Promise<CommandState>;
  readonly setTerminalCommand?: (action: "install" | "remove") => Promise<CommandChange>;
  /** Whether the page holds unsaved edits, which the app's quit and restart boxes warn of. */
  readonly unsaved?: (held: boolean) => void;
}

declare global {
  var eidolonDesktop: EidolonDesktop | undefined;
}

/** The bridge, or null in a browser. */
export function desktop(): EidolonDesktop | null {
  return globalThis.eidolonDesktop ?? null;
}

/** The editors holding unsaved edits now. */
let unsavedHolds = 0;

/**
 * Holds the page as one with unsaved edits until the release it returns. The desktop app hears true
 * as the first hold starts and false as the last ends.
 */
export function holdUnsaved(): () => void {
  unsavedHolds++;
  if (unsavedHolds === 1) desktop()?.unsaved?.(true);
  return () => {
    unsavedHolds--;
    if (unsavedHolds === 0) desktop()?.unsaved?.(false);
  };
}

/** What each command the desktop app sends does here; any other is ignored. */
const COMMANDS = {
  settings: (navigate) => navigate("/settings"),
  tasks: (navigate) => navigate("/tasks"),
} satisfies Record<string, (navigate: (to: string) => void) => void>;

/** A chat's or a task's id, as the server makes them. */
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A notification's click: the task, in its chat. */
const OPEN_TASK = new RegExp(`^open-task:(${ID}):(${ID})$`);

export type DesktopCommand = keyof typeof COMMANDS | `open-task:${string}:${string}`;

export function runCommand(command: string, navigate: (to: string) => void): void {
  if (Object.hasOwn(COMMANDS, command)) {
    COMMANDS[command as keyof typeof COMMANDS](navigate);
    return;
  }
  const [, chat, task] = OPEN_TASK.exec(command) ?? [];
  if (chat !== undefined && task !== undefined) navigate(`/chats/${chat}?task=${task}`);
}

/**
 * Tells the desktop app the theme setting and the language, now and on every change, and runs its
 * commands through `navigate`. Nothing in a browser.
 */
export function connectDesktop(navigate: (to: string) => void): void {
  const app = desktop();
  if (app === null) return;
  let theme: Theme | null = null;
  const reportTheme = (next: Theme) => {
    if (next === theme) return;
    theme = next;
    app.setTheme(next);
  };
  reportTheme(themeSetting());
  onThemeChange(reportTheme);
  let language: string | null = null;
  // Lingui announces a catalog's load before it activates it, so the active locale decides.
  const reportLanguage = () => {
    const next = i18n.locale;
    if (!next || next === language) return;
    language = next;
    app.setLanguage(next as Lang);
  };
  reportLanguage();
  i18n.on("change", reportLanguage);
  app.onCommand((command) => runCommand(command, navigate));
}
