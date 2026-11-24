// The desktop app's bridges: its preload puts `eidolonDesktop` on the app's own page and
// `eidolonCompanion` on the desktop companion's, and a browser has neither, so everything that
// differs in the desktop app asks `desktop()`, or on her page `companion()`, first. The page can
// come from a server of another version than the app's, so a member added since the first release
// is optional, and asked for before it's used.
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

export const COMPANION_SIZES = ["small", "medium", "large"] as const;
export type CompanionSize = (typeof COMPANION_SIZES)[number];

/** What Settings shows of the desktop companion. */
export interface CompanionState {
  readonly on: boolean;
  /** At a launch at login she shows before the window does. */
  readonly showAtLogin: boolean;
  /** Background mode keeps her off screen in this run. */
  readonly background: boolean;
}

export interface CompanionChange {
  readonly on?: boolean;
  readonly showAtLogin?: boolean;
}

/** What her window holds: her model, its framing `aspect` wide for its height, or her picture. */
export type CompanionShape =
  | { readonly kind: "model"; readonly aspect: number }
  | { readonly kind: "picture" };
export type CompanionDrawn = CompanionShape["kind"];

export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

/** A drag of her window, the pointer's position in screen DIPs. */
export interface CompanionDrag {
  readonly phase: "start" | "move" | "end";
  readonly x: number;
  readonly y: number;
}

/** The cursor, relative to her window's top left, in DIPs; outside her window too. */
export interface CompanionCursor {
  readonly x: number;
  readonly y: number;
}

export interface CompanionNamed {
  readonly id: string;
  readonly name: string;
}

export interface CompanionMenuState {
  /** up: Hang Up and Mute act on the call; idle: Call places /call's call with her; open: Call opens /call. */
  readonly call: "idle" | "open" | "up";
  readonly live: boolean;
  readonly micOn: boolean;
  /** Her character models, the active one `model`. */
  readonly models: readonly CompanionNamed[];
  readonly model: string | null;
  /** The active model's outfits, the one worn `outfit`. */
  readonly outfits: readonly CompanionNamed[];
  readonly outfit: string | null;
}

export type CompanionPick =
  | "call"
  | "hang-up"
  | "mute"
  | "unmute"
  | "open"
  | "always-on-top"
  | "hide"
  | `size:${CompanionSize}`
  | `model:${string}`
  | `outfit:${string}`;

/** The picks main hands the app page's call; never the port's. */
export type CompanionCallPick = "call" | "hang-up" | "mute" | "unmute";

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
  /** The desktop companion, as Settings shows her. */
  readonly companion?: () => Promise<CompanionState>;
  readonly setCompanion?: (change: CompanionChange) => Promise<CompanionState>;
  /** Turns her on and, once she is drawn, hides the window: she carries the call. */
  readonly popOut?: () => Promise<CompanionState>;
  /** Asks main for a port to the desktop companion's page; it arrives as a window message. */
  readonly linkCompanion?: () => void;
  /** Whether a call she is on is up here, which keeps the window drawing for her. */
  readonly feedingCompanion?: (feeding: boolean) => void;
  /** Hands `callback` each pick the owner clicked in her menu for the call. */
  readonly onCompanionPick?: (callback: (pick: CompanionCallPick) => void) => void;
}

/** `window.eidolonCompanion`, on the desktop companion's page alone. */
export interface EidolonCompanion {
  readonly platform: string;
  /** Asks main for a port to the app window; it arrives as a window message. */
  readonly link: () => void;
  readonly hit: (over: boolean) => void;
  readonly drag: (drag: CompanionDrag) => void;
  /** Her shape; main answers the size it gave her window. */
  readonly shape: (shape: CompanionShape) => Promise<WindowSize>;
  readonly drawn: (drawn: CompanionDrawn | null) => void;
  readonly follow: (on: boolean) => void;
  readonly onCursor: (callback: (cursor: CompanionCursor) => void) => void;
  readonly menu: (state: CompanionMenuState) => Promise<CompanionPick | null>;
}

declare global {
  var eidolonDesktop: EidolonDesktop | undefined;
  var eidolonCompanion: EidolonCompanion | undefined;
}

/** The bridge, or null in a browser. */
export function desktop(): EidolonDesktop | null {
  return globalThis.eidolonDesktop ?? null;
}

/** The desktop companion's bridge: only her own page has one. */
export function companion(): EidolonCompanion | null {
  return globalThis.eidolonCompanion ?? null;
}

/** Whether the app offers Pop Out, which hands a call to the desktop companion. */
export function offersPopOut(app: EidolonDesktop | null): boolean {
  return app?.popOut !== undefined;
}

/** What each command the desktop app sends does here; any other is ignored. */
const COMMANDS = {
  settings: (navigate) => navigate("/settings"),
  tasks: (navigate) => navigate("/tasks"),
  call: (navigate) => navigate("/call"),
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

const pickListeners = new Set<(pick: CompanionCallPick) => void>();

/** Hands `listener` each pick from her menu main sends for the call; the function it returns stops it. */
export function subscribeCompanionPick(listener: (pick: CompanionCallPick) => void): () => void {
  pickListeners.add(listener);
  return () => {
    pickListeners.delete(listener);
  };
}

/**
 * Tells the desktop app the theme setting and the language, now and on every change, runs its
 * commands through `navigate`, and hands her menu's call picks to their subscribers, a pick with
 * none being dropped. Nothing in a browser.
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
  app.onCompanionPick?.((pick) => {
    for (const listener of [...pickListeners]) listener(pick);
  });
}

/**
 * Hands `callback` each port main pairs this page with the desktop companion (or her page with
 * the app window): a window message from this window itself, tagged `{eidolon: "companion-port"}`,
 * with one port. The function it returns stops listening.
 */
export function onCompanionPort(callback: (port: MessagePort) => void): () => void {
  const listener = (event: MessageEvent) => {
    if ((event.source as unknown) !== globalThis) return;
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    if ((data as { readonly eidolon?: unknown }).eidolon !== "companion-port") return;
    const [port, ...others] = event.ports;
    if (port !== undefined && others.length === 0) callback(port);
  };
  globalThis.addEventListener("message", listener);
  return () => globalThis.removeEventListener("message", listener);
}
