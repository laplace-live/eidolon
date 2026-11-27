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

export type ChangeKind = "feature" | "performance" | "improvement" | "fix" | "other";

export const DESKTOP_PACKAGE = "laplace-eidolon-desktop";

export interface ReleaseNoteItem {
  readonly kind: ChangeKind;
  readonly packages: readonly string[];
  readonly text: string;
}

export interface ReleaseNoteEntry {
  readonly date: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly items: readonly ReleaseNoteItem[];
}

export type UpdateState =
  | { readonly phase: "unsupported" }
  | { readonly phase: "read-only" }
  | { readonly phase: "idle" }
  | { readonly phase: "checking" }
  | {
      readonly phase: "available";
      readonly version: string;
      readonly notes: readonly ReleaseNoteEntry[];
    }
  | { readonly phase: "downloading"; readonly version: string; readonly percent: number }
  | {
      readonly phase: "downloaded";
      readonly version: string;
      readonly notes: readonly ReleaseNoteEntry[];
    }
  | {
      readonly phase: "installing";
      readonly version: string;
      readonly notes: readonly ReleaseNoteEntry[];
    }
  | { readonly phase: "error"; readonly version: string; readonly message: string };

export type UpdateCheckOutcome =
  | { readonly outcome: "available"; readonly version: string }
  | { readonly outcome: "none" }
  | { readonly outcome: "error"; readonly message: string };

export const PERMISSION_IDS = [
  "microphone",
  "notifications",
  "local-network",
  "screen",
  "accessibility",
] as const;
export type PermissionId = (typeof PERMISSION_IDS)[number];

export type PermissionStatus =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unknown"
  | "unavailable";

export interface PermissionItem {
  readonly id: PermissionId;
  readonly status: PermissionStatus;
  readonly unavailable?: Unavailable;
}

export interface PermissionsState {
  readonly background: boolean;
  readonly items: readonly PermissionItem[];
}

export interface PermissionRequestResult {
  readonly id: PermissionId;
  readonly status: PermissionStatus;
  readonly openedSettings: boolean;
  readonly unavailable?: Unavailable;
}

export interface LocalNetworkTestRequest {
  readonly host: string;
  readonly port: number;
}

export type LocalNetworkTestFailure =
  | "invalid-target"
  | "blocked"
  | "refused"
  | "timeout"
  | "unresolved"
  | "unsupported"
  | "background"
  | "failed";

export type LocalNetworkTestResult =
  | { readonly ok: true; readonly host: string; readonly port: number; readonly testedAt: number }
  | {
      readonly ok: false;
      readonly host: string;
      readonly port: number;
      readonly testedAt: number;
      readonly failure: LocalNetworkTestFailure;
    };

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
  /** The desktop companion, as Settings shows her. */
  readonly companion?: () => Promise<CompanionState>;
  readonly setCompanion?: (change: CompanionChange) => Promise<CompanionState>;
  /** Turns her on and, once she is drawn, hides the window: she carries the call. */
  readonly popOut?: () => Promise<CompanionState>;
  /** Stands her at her first place, saved; then her state. */
  readonly resetCompanionPlace?: () => Promise<CompanionState>;
  /** Shows a model's file in Finder or Explorer; false when it isn't there. */
  readonly revealModel?: (model: {
    readonly persona: string;
    readonly model: string;
  }) => Promise<boolean>;
  /** Asks main for a port to the desktop companion's page; it arrives as a window message. */
  readonly linkCompanion?: () => void;
  /** Whether a call she is on is up here, which keeps the window drawing for her. */
  readonly feedingCompanion?: (feeding: boolean) => void;
  /** Hands `callback` each pick the owner clicked in her menu for the call. */
  readonly onCompanionPick?: (callback: (pick: CompanionCallPick) => void) => void;
  /**
   * Hands `callback` whether the window shows, now and at each change: hidden while it feeds her, its
   * page still runs, as throttling's off.
   */
  readonly onWindowShows?: (callback: (shows: boolean) => void) => void;
  /** Hands `callback` the updater's state, now and at each change. */
  readonly onUpdateState?: (callback: (state: UpdateState) => void) => void;
  /** Checks the update feed, surfacing skipped versions and reporting the outcome. */
  readonly updateCheck?: () => Promise<UpdateCheckOutcome>;
  /** Starts or retries downloading the offered update. */
  readonly updateDownload?: () => Promise<void>;
  /** Restarts to install the downloaded update. */
  readonly updateInstall?: () => Promise<void>;
  /** Skips the offered version so quiet checks stay silent about it. */
  readonly updateSkip?: () => Promise<void>;
  /** OS permissions relevant to LAPLACE Eidolon on this computer. */
  readonly permissions?: () => Promise<PermissionsState>;
  /** Prompts macOS for access or opens the OS settings pane when already decided. */
  readonly requestPermission?: (id: PermissionId) => Promise<PermissionRequestResult>;
  /** Opens the OS settings pane for `id`. */
  readonly openPermissionSettings?: (id: PermissionId) => Promise<boolean>;
  /** Tests a LAN TCP connection via Electron's Node runtime. */
  readonly testLocalNetwork?: (target: LocalNetworkTestRequest) => Promise<LocalNetworkTestResult>;
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
  call: (navigate) => navigate("/call"),
  "check-updates": (_navigate, onCheckUpdates) => onCheckUpdates?.(),
} satisfies Record<string, (navigate: (to: string) => void, onCheckUpdates?: () => void) => void>;

/** A chat's or a task's id, as the server makes them. */
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A notification's click: a chat, or a task in its chat. */
const OPEN_CHAT = new RegExp(`^open-chat:(${ID})$`);
const OPEN_TASK = new RegExp(`^open-task:(${ID}):(${ID})$`);

export type DesktopCommand =
  | keyof typeof COMMANDS
  | `open-chat:${string}`
  | `open-task:${string}:${string}`;

export function runCommand(
  command: string,
  navigate: (to: string) => void,
  onCheckUpdates?: () => void,
): void {
  if (Object.hasOwn(COMMANDS, command)) {
    COMMANDS[command as keyof typeof COMMANDS](navigate, onCheckUpdates);
    return;
  }
  const [, openChat] = OPEN_CHAT.exec(command) ?? [];
  if (openChat !== undefined) {
    navigate(`/chats/${openChat}`);
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

let shown = true;
const showsListeners = new Set<() => void>();

/** Whether the desktop app's window shows, as main last said; true in a browser. */
export function windowShows(): boolean {
  return shown;
}

/** Calls `listener` at each change of windowShows(); the function it returns stops it. */
export function subscribeWindowShows(listener: () => void): () => void {
  showsListeners.add(listener);
  return () => {
    showsListeners.delete(listener);
  };
}

let update: UpdateState = { phase: "unsupported" };
const updateListeners = new Set<() => void>();

/** The updater's state, as main last reported it; `unsupported` in a browser. */
export function updateState(): UpdateState {
  return update;
}

/** Calls `listener` when the updater's state changes; the returned function stops it. */
export function subscribeUpdateState(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

function sameUpdateState(a: UpdateState, b: UpdateState): boolean {
  if (a === b) return true;
  if (a.phase !== b.phase) return false;
  if (
    a.phase === "unsupported" ||
    a.phase === "read-only" ||
    a.phase === "idle" ||
    a.phase === "checking"
  ) {
    return true;
  }
  if (a.phase === "downloading" && b.phase === "downloading") {
    return a.version === b.version && a.percent === b.percent;
  }
  if (a.phase === "error" && b.phase === "error") {
    return a.version === b.version && a.message === b.message;
  }
  if (
    (a.phase === "available" || a.phase === "downloaded" || a.phase === "installing") &&
    (b.phase === "available" || b.phase === "downloaded" || b.phase === "installing")
  ) {
    return (
      a.version === b.version &&
      (a.notes === b.notes ||
        (a.notes.length === 0 && b.notes.length === 0) ||
        JSON.stringify(a.notes) === JSON.stringify(b.notes))
    );
  }
  return false;
}

/** Updates the mirrored updater state (exported for tests; runtime drives this via onUpdateState). */
export function setUpdateState(next: UpdateState): void {
  if (sameUpdateState(update, next)) return;
  update = next;
  for (const listener of [...updateListeners]) listener();
}

/**
 * Tells the desktop app the theme setting and the language, now and on every change, runs its
 * commands through `navigate`, hands her menu's call picks to their subscribers, a pick with none
 * being dropped, and keeps whether its window shows and the updater's state. Nothing in a browser.
 */
export function connectDesktop(navigate: (to: string) => void, onCheckUpdates?: () => void): void {
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
  // Seed update state before registering commands so a queued check-updates sees current state.
  app.onUpdateState?.((next) => setUpdateState(next));
  app.onCommand((command) => runCommand(command, navigate, onCheckUpdates));
  app.onCompanionPick?.((pick) => {
    for (const listener of [...pickListeners]) listener(pick);
  });
  app.onWindowShows?.((shows) => {
    if (shows === shown) return;
    shown = shows;
    for (const listener of [...showsListeners]) listener();
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
