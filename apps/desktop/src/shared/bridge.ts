// The bridges between the windows' pages and main: the IPC channels, what each carries, and which
// window's page may use it. The sandboxed preload bundles it too, so it imports nothing at runtime.
import type { ChangeKind, ReleaseNoteEntry, ReleaseNoteItem } from "./release-notes.ts";

export type { ChangeKind, ReleaseNoteEntry, ReleaseNoteItem };

export const SCHEME = "eidolon-app";

/** The window's two kinds of page: the app's own, from the backend, and the shell's. */
export type Page = "app" | "shell";

/** The app's two windows: the main one, and the desktop companion's. */
export type WindowKind = "main" | "companion";

/** The switch main gives her renderer (additionalArguments), which her preload finds in process.argv. */
export const COMPANION_SWITCH = "--eidolon-window=companion";

/** Which window a preload runs in, by its renderer's arguments. */
export function windowKindOf(argv: readonly string[]): WindowKind {
  return argv.includes(COMPANION_SWITCH) ? "companion" : "main";
}

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
 * know. `open-chat:<chat>` opens a chat, `open-task:<chat>:<task>` opens a task in its chat,
 * `check-updates` checks for updates (or opens the update dialog), and `call` opens /call.
 */
export type DesktopCommand =
  | "settings"
  | "tasks"
  | "call"
  | "check-updates"
  | `open-chat:${string}`
  | `open-task:${string}:${string}`;

/** The command that opens `chat`; throws unless it is an id. */
export function openChatCommand(chat: string): `open-chat:${string}` {
  if (!ID_PATTERN.test(chat)) throw new Error("opening a chat takes a chat's id");
  return `open-chat:${chat}`;
}

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
  /** App page → main, with a boolean: whether the page holds unsaved edits now. */
  unsaved: "eidolon:unsaved",
  /**
   * Main → any page, on macOS: whether the window is fullscreen, on entering and leaving it and
   * after each navigation, since a new page starts without the mark.
   */
  fullscreen: "eidolon:fullscreen",
  /** Shell page → main, with nothing: the failure page's buttons. */
  retry: "eidolon:retry",
  showLogs: "eidolon:show-logs",
  quit: "eidolon:quit",
  /** App page → main, invoked with nothing: the desktop companion's CompanionState, for Settings. */
  companion: "eidolon:companion",
  /** App page → main, invoked with a CompanionChange: then the CompanionState. */
  setCompanion: "eidolon:set-companion",
  /**
   * App page → main, invoked with nothing: turns her on to carry the call, and hides the window
   * once she is drawn; then the CompanionState.
   */
  popOut: "eidolon:pop-out",
  /** App page → main, invoked with nothing: stands her at her first place, saved; then the CompanionState. */
  resetCompanionPlace: "eidolon:reset-companion-place",
  /** App page → main, invoked with a ModelRef: shows the model's file in Finder or Explorer; whether it was there. */
  revealModel: "eidolon:reveal-model",
  /** App page → main, with nothing: it listens for a port to the companion's page. */
  linkCompanion: "eidolon:link-companion",
  /** App page → main: a boolean, whether a call she is on is up. */
  feedingCompanion: "eidolon:feeding-companion",
  /** Main → app page: a CompanionCallPick the owner clicked in her menu, for the call. */
  companionPick: "eidolon:companion-pick",
  /**
   * Main → app page: a boolean, whether its window shows, at each change. App page → main,
   * synchronous: the same, read as the page asks for it, since a page loads before it hears a change.
   */
  windowShows: "eidolon:window-shows",
  /** Main → both pages, through postMessage: a MessagePort to the other page, in the event's ports. */
  companionPort: "eidolon:companion-port",
  /**
   * Main → app page: the updater's UpdateState, at each change. App page → main, synchronous: the
   * same, read as the page asks for it, since an update or check can land before the page loads.
   */
  updateState: "eidolon:update-state",
  /** App page → main, invoked with nothing: checks the update feed and returns UpdateCheckOutcome. */
  updateCheck: "eidolon:update-check",
  /** App page → main, invoked with nothing: starts or retries downloading the offered update. */
  updateDownload: "eidolon:update-download",
  /** App page → main, invoked with nothing: restarts to install the downloaded update. */
  updateInstall: "eidolon:update-install",
  /** App page → main, invoked with nothing: skips the offered version and returns to idle. */
  updateSkip: "eidolon:update-skip",
  /** App page → main, invoked with nothing: OS permission states for this computer. */
  permissions: "eidolon:permissions",
  /** App page → main, invoked with a PermissionId: prompts macOS or opens settings. */
  requestPermission: "eidolon:request-permission",
  /** App page → main, invoked with a PermissionId: opens the OS settings pane for that permission. */
  openPermissionSettings: "eidolon:open-permission-settings",
  /** App page → main, invoked with LocalNetworkTestRequest: tests a LAN TCP connection via Electron's Node. */
  testLocalNetwork: "eidolon:test-local-network",
  /** Companion page → main, with nothing: it listens for a port to the app page. */
  linkApp: "eidolon:link-app",
  /** Companion page → main: a boolean, whether she is under the pointer. */
  companionHit: "eidolon:companion-hit",
  /** Companion page → main: a CompanionDrag. */
  companionDrag: "eidolon:companion-drag",
  /** Companion page → main, invoked with a CompanionShape: the WindowSize main gave her window. */
  companionShape: "eidolon:companion-shape",
  /** Companion page → main: the CompanionDrawn she is drawn as, or null while she isn't. */
  companionDrawn: "eidolon:companion-drawn",
  /** Companion page → main: a boolean, whether she follows the cursor. */
  companionFollow: "eidolon:companion-follow",
  /** Companion page → main, invoked with a CompanionMenuState: the CompanionPick, or null. */
  companionMenu: "eidolon:companion-menu",
  /** Main → companion page: a CompanionCursor. */
  companionCursor: "eidolon:companion-cursor",
} as const;

/**
 * The channels main listens on, each with the one window and page whose main frame may send on it.
 * Both windows' pages are at the app's address: only the window tells them apart.
 */
const SENDERS = {
  [BRIDGE.theme]: ["main", "app"],
  [BRIDGE.language]: ["main", "app"],
  [BRIDGE.versions]: ["main", "app"],
  [BRIDGE.takesCommands]: ["main", "app"],
  [BRIDGE.chooseFolder]: ["main", "app"],
  [BRIDGE.loginItem]: ["main", "app"],
  [BRIDGE.setLoginItem]: ["main", "app"],
  [BRIDGE.terminalCommand]: ["main", "app"],
  [BRIDGE.setTerminalCommand]: ["main", "app"],
  [BRIDGE.unsaved]: ["main", "app"],
  [BRIDGE.retry]: ["main", "shell"],
  [BRIDGE.showLogs]: ["main", "shell"],
  [BRIDGE.quit]: ["main", "shell"],
  [BRIDGE.companion]: ["main", "app"],
  [BRIDGE.setCompanion]: ["main", "app"],
  [BRIDGE.popOut]: ["main", "app"],
  [BRIDGE.resetCompanionPlace]: ["main", "app"],
  [BRIDGE.revealModel]: ["main", "app"],
  [BRIDGE.linkCompanion]: ["main", "app"],
  [BRIDGE.feedingCompanion]: ["main", "app"],
  [BRIDGE.windowShows]: ["main", "app"],
  [BRIDGE.updateState]: ["main", "app"],
  [BRIDGE.updateCheck]: ["main", "app"],
  [BRIDGE.updateDownload]: ["main", "app"],
  [BRIDGE.updateInstall]: ["main", "app"],
  [BRIDGE.updateSkip]: ["main", "app"],
  [BRIDGE.permissions]: ["main", "app"],
  [BRIDGE.requestPermission]: ["main", "app"],
  [BRIDGE.openPermissionSettings]: ["main", "app"],
  [BRIDGE.testLocalNetwork]: ["main", "app"],
  [BRIDGE.linkApp]: ["companion", "app"],
  [BRIDGE.companionHit]: ["companion", "app"],
  [BRIDGE.companionDrag]: ["companion", "app"],
  [BRIDGE.companionShape]: ["companion", "app"],
  [BRIDGE.companionDrawn]: ["companion", "app"],
  [BRIDGE.companionFollow]: ["companion", "app"],
  [BRIDGE.companionMenu]: ["companion", "app"],
} as const satisfies Record<string, readonly [WindowKind, Page]>;

export type PageChannel = keyof typeof SENDERS;

/** Who sent an IPC message, as main sees it on the event. */
export interface IpcSender {
  /** Which of the app's windows sent it, by its webContents; null for anything else. */
  readonly window: WindowKind | null;
  /** Whether it came from that window's main frame. */
  readonly mainFrame: boolean;
  /**
   * The sending frame's origin, not its URL: a sandboxed document the backend serves has an app
   * URL and an opaque origin, "null". Null once the frame is gone.
   */
  readonly origin: string | null;
}

/**
 * Whether main takes a message on `channel` from `sender`: only from the channel's window and page,
 * in that window's main frame. Never widen it to any window of the app's: the companion's page would
 * then reach the system options, the folder dialog, the theme and the language.
 */
export function accepts(channel: PageChannel, sender: IpcSender): boolean {
  const [kind, page] = SENDERS[channel];
  return (
    sender.window === kind &&
    sender.mainFrame &&
    sender.origin !== null &&
    pageAt(sender.origin) === page
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

export const COMPANION_SIZES = ["small", "medium", "large"] as const;
export type CompanionSize = (typeof COMPANION_SIZES)[number];

export function isCompanionSize(value: unknown): value is CompanionSize {
  return (COMPANION_SIZES as readonly unknown[]).includes(value);
}

/** What Settings shows of her. */
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

/** A persona's character model, by the ids the server gave them. */
export interface ModelRef {
  readonly persona: string;
  readonly model: string;
}

/** A persona's or a model's id: a lowercase slug, never a path. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isModelRef(value: unknown): value is ModelRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { persona, model } = value as Record<string, unknown>;
  return (
    typeof persona === "string" &&
    SLUG_PATTERN.test(persona) &&
    typeof model === "string" &&
    SLUG_PATTERN.test(model)
  );
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

/** The picks main hands the app page's call (BRIDGE.companionPick); never the port's. */
export const COMPANION_CALL_PICKS = ["call", "hang-up", "mute", "unmute"] as const;
export type CompanionCallPick = (typeof COMPANION_CALL_PICKS)[number];

const PLAIN_PICKS: readonly unknown[] = [
  ...COMPANION_CALL_PICKS,
  "open",
  "always-on-top",
  "hide",
] satisfies readonly CompanionPick[];

/** The narrowest and widest framing her window takes. */
const ASPECTS = { min: 0.1, max: 4 } as const;
/** Farther than any display: a point past it is no pointer's. */
const COORDINATE_LIMIT = 1e6;
/** A window's side past any display's. */
const SIDE_LIMIT = 10_000;
/** A model's id, as the server mints them. */
const MODEL_ID = SLUG_PATTERN;
/** An outfit's key, as the server takes them. */
const OUTFIT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MENU_MODELS = 50;
const MENU_OUTFITS = 32;
const NAME_CHARS = 200;

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT;
}

function isSide(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= SIDE_LIMIT;
}

/** Main's answer on BRIDGE.companion, setCompanion and popOut, off where it sent something else. */
export function companionStateOf(answer: unknown): CompanionState {
  const { on, showAtLogin, background } = fields(answer);
  return { on: on === true, showAtLogin: showAtLogin !== false, background: background === true };
}

export function isCompanionCallPick(value: unknown): value is CompanionCallPick {
  return (COMPANION_CALL_PICKS as readonly unknown[]).includes(value);
}

/** At least one of `on` and `showAtLogin`, each a boolean, and nothing else. */
export function isCompanionChange(value: unknown): value is CompanionChange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([key, flag]) => (key === "on" || key === "showAtLogin") && typeof flag === "boolean",
    )
  );
}

/** Her shape: her picture, or her model with an aspect her window takes; null for anything else. */
export function companionShapeOf(value: unknown): CompanionShape | null {
  const { kind, aspect } = fields(value);
  if (kind === "picture") return { kind };
  const fits =
    typeof aspect === "number" &&
    Number.isFinite(aspect) &&
    aspect >= ASPECTS.min &&
    aspect <= ASPECTS.max;
  return kind === "model" && fits ? { kind, aspect } : null;
}

export function isCompanionDrawn(value: unknown): value is CompanionDrawn | null {
  return value === null || value === "model" || value === "picture";
}

export function companionDragOf(value: unknown): CompanionDrag | null {
  const { phase, x, y } = fields(value);
  const known = phase === "start" || phase === "move" || phase === "end";
  return known && isCoordinate(x) && isCoordinate(y) ? { phase, x, y } : null;
}

export function companionCursorOf(value: unknown): CompanionCursor | null {
  const { x, y } = fields(value);
  return isCoordinate(x) && isCoordinate(y) ? { x, y } : null;
}

/** Up to `most` items, each an id `id` takes and a name of NAME_CHARS at most; null otherwise. */
function namedOf(value: unknown, id: RegExp, most: number): CompanionNamed[] | null {
  if (!Array.isArray(value) || value.length > most) return null;
  const named: CompanionNamed[] = [];
  for (const item of value) {
    const { id: itemId, name } = fields(item);
    if (typeof itemId !== "string" || !id.test(itemId)) return null;
    if (typeof name !== "string" || name.length > NAME_CHARS) return null;
    named.push({ id: itemId, name });
  }
  return named;
}

/** Null, or an id `id` takes, listed or not; undefined for anything else. */
function chosenOf(value: unknown, id: RegExp): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && id.test(value) ? value : undefined;
}

/**
 * Her menu's state as main takes it: the active model and the worn outfit may fall past the lists'
 * caps, and then no item is checked.
 */
export function companionMenuStateOf(value: unknown): CompanionMenuState | null {
  const { call, live, micOn, models, model, outfits, outfit } = fields(value);
  if (call !== "idle" && call !== "open" && call !== "up") return null;
  if (typeof live !== "boolean" || typeof micOn !== "boolean") return null;
  const modelList = namedOf(models, MODEL_ID, MENU_MODELS);
  const outfitList = namedOf(outfits, OUTFIT_ID, MENU_OUTFITS);
  const active = chosenOf(model, MODEL_ID);
  const worn = chosenOf(outfit, OUTFIT_ID);
  if (modelList === null || outfitList === null || active === undefined || worn === undefined) {
    return null;
  }
  return { call, live, micOn, models: modelList, model: active, outfits: outfitList, outfit: worn };
}

/** Main's answer on BRIDGE.companionShape: positive whole sides no display exceeds, else null. */
export function windowSizeOf(answer: unknown): WindowSize | null {
  const { width, height } = fields(answer);
  return isSide(width) && isSide(height) ? { width, height } : null;
}

/** Main's answer on BRIDGE.companionMenu: one of her menu's picks, else null. */
export function companionPickOf(answer: unknown): CompanionPick | null {
  if (typeof answer !== "string") return null;
  if (PLAIN_PICKS.includes(answer)) return answer as CompanionPick;
  if (answer.startsWith("size:")) {
    return isCompanionSize(answer.slice("size:".length)) ? (answer as CompanionPick) : null;
  }
  if (answer.startsWith("model:")) {
    return MODEL_ID.test(answer.slice("model:".length)) ? (answer as CompanionPick) : null;
  }
  if (answer.startsWith("outfit:")) {
    const id = answer.slice("outfit:".length);
    return id === "" || OUTFIT_ID.test(id) ? (answer as CompanionPick) : null;
  }
  return null;
}

/** Cross-process update flow state, owned by main and pushed on BRIDGE.updateState. */
export type UpdateState =
  | { readonly phase: "unsupported" }
  /** macOS, on a read-only volume: nothing is checked, and Check for Updates… says to move it. */
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
  /**
   * Restart chosen: the hop that makes a second Restart a no-op, since quitAndInstall twice asks
   * Squirrel to relaunch twice, which leaves two copies running. A Cancel in the quit check hands
   * it back to downloaded.
   */
  | {
      readonly phase: "installing";
      readonly version: string;
      readonly notes: readonly ReleaseNoteEntry[];
    }
  /** The download failed, or the update it gave can't install. */
  | { readonly phase: "error"; readonly version: string; readonly message: string };

/** One check's result; check failures surface as a toast here, never in UpdateState. */
export type UpdateCheckOutcome =
  | { readonly outcome: "available"; readonly version: string }
  | { readonly outcome: "none" }
  | { readonly outcome: "error"; readonly message: string };

/** Main's push/answer on BRIDGE.updateState, or unsupported when it sent something else. */
export function updateStateOf(
  answer: unknown,
  parseNotes: (raw: unknown) => readonly ReleaseNoteEntry[] = () => [],
): UpdateState {
  const { phase, version, percent, notes, message } = fields(answer);
  if (
    phase === "unsupported" ||
    phase === "read-only" ||
    phase === "idle" ||
    phase === "checking"
  ) {
    return { phase };
  }
  if (typeof version !== "string" || version.length === 0) return { phase: "unsupported" };
  if (phase === "available" || phase === "downloaded" || phase === "installing") {
    return { phase, version, notes: parseNotes(notes) };
  }
  if (phase === "downloading") {
    if (typeof percent !== "number" || !Number.isFinite(percent)) return { phase: "unsupported" };
    return { phase, version, percent: Math.min(100, Math.max(0, Math.round(percent))) };
  }
  if (phase === "error" && typeof message === "string") return { phase, version, message };
  return { phase: "unsupported" };
}

/** Main's answer on BRIDGE.updateCheck, or none when it sent something else. */
export function updateCheckOutcomeOf(answer: unknown): UpdateCheckOutcome {
  const { outcome, version, message } = fields(answer);
  if (outcome === "available" && typeof version === "string" && version.length > 0) {
    return { outcome, version };
  }
  if (outcome === "error" && typeof message === "string") return { outcome, message };
  return { outcome: "none" };
}

export const PERMISSION_IDS = [
  "microphone",
  "notifications",
  "local-network",
  "screen",
  "accessibility",
] as const;
export type PermissionId = (typeof PERMISSION_IDS)[number];

export function isPermissionId(value: unknown): value is PermissionId {
  return (PERMISSION_IDS as readonly unknown[]).includes(value);
}

export const PERMISSION_STATUSES = [
  "granted",
  "denied",
  "restricted",
  "not-determined",
  "unknown",
  "unavailable",
] as const;
export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

export function isPermissionStatus(value: unknown): value is PermissionStatus {
  return (PERMISSION_STATUSES as readonly unknown[]).includes(value);
}

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

export const LOCAL_NETWORK_TEST_FAILURES = [
  "invalid-target",
  "blocked",
  "refused",
  "timeout",
  "unresolved",
  "unsupported",
  "background",
  "failed",
] as const;
export type LocalNetworkTestFailure = (typeof LOCAL_NETWORK_TEST_FAILURES)[number];

export type LocalNetworkTestResult =
  | { readonly ok: true; readonly host: string; readonly port: number; readonly testedAt: number }
  | {
      readonly ok: false;
      readonly host: string;
      readonly port: number;
      readonly testedAt: number;
      readonly failure: LocalNetworkTestFailure;
    };

function isLocalNetworkTestFailure(value: unknown): value is LocalNetworkTestFailure {
  return (LOCAL_NETWORK_TEST_FAILURES as readonly unknown[]).includes(value);
}

export function isLocalNetworkTestRequest(value: unknown): value is LocalNetworkTestRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { host, port } = value as Record<string, unknown>;
  return (
    typeof host === "string" &&
    host.length <= 256 &&
    typeof port === "number" &&
    Number.isFinite(port)
  );
}

function validUnavailable(value: unknown): Unavailable | undefined {
  return UNAVAILABLE.includes(value) ? (value as Unavailable) : undefined;
}

/** Main's answer on BRIDGE.permissions, or an empty list when malformed. */
export function permissionsStateOf(answer: unknown): PermissionsState {
  const { background, items } = fields(answer);
  const parsed: PermissionItem[] = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      const { id, status, unavailable } = fields(item);
      if (!isPermissionId(id) || !isPermissionStatus(status)) continue;
      const reason = validUnavailable(unavailable);
      parsed.push({ id, status, ...(reason !== undefined ? { unavailable: reason } : {}) });
    }
  }
  return { background: background === true, items: parsed };
}

/** Main's answer on BRIDGE.requestPermission, or unknown when malformed. */
export function permissionRequestResultOf(
  answer: unknown,
  fallbackId: PermissionId,
): PermissionRequestResult {
  const { id, status, openedSettings, unavailable } = fields(answer);
  const reason = validUnavailable(unavailable);
  return {
    id: isPermissionId(id) ? id : fallbackId,
    status: isPermissionStatus(status) ? status : "unknown",
    openedSettings: openedSettings === true,
    ...(reason !== undefined ? { unavailable: reason } : {}),
  };
}

/** Main's answer on BRIDGE.testLocalNetwork, or failed when malformed. */
export function localNetworkTestResultOf(answer: unknown): LocalNetworkTestResult {
  const { ok, host: rawHost, port: rawPort, testedAt: rawTestedAt, failure } = fields(answer);
  const host = typeof rawHost === "string" ? rawHost : "";
  const port =
    typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65_535
      ? rawPort
      : 0;
  const testedAt =
    typeof rawTestedAt === "number" && Number.isFinite(rawTestedAt) ? rawTestedAt : 0;
  if (ok === true) return { ok: true, host, port, testedAt };
  return {
    ok: false,
    host,
    port,
    testedAt,
    failure: isLocalNetworkTestFailure(failure) ? failure : "failed",
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
  /** Whether the page holds unsaved edits, which the quit and restart boxes warn of. */
  readonly unsaved: (held: boolean) => void;
  /** The desktop companion, as Settings shows her. */
  readonly companion: () => Promise<CompanionState>;
  /** Turns her, or her showing at login, on or off; then her state. */
  readonly setCompanion: (change: CompanionChange) => Promise<CompanionState>;
  /** Turns her on to carry the call, and hides the window once she is drawn; then her state. */
  readonly popOut: () => Promise<CompanionState>;
  /** Stands her at her first place, saved; then her state. */
  readonly resetCompanionPlace: () => Promise<CompanionState>;
  /** Shows a model's file in Finder or Explorer; false when it isn't there. */
  readonly revealModel: (model: ModelRef) => Promise<boolean>;
  /** Asks main for a port to the companion's page; it arrives as a window message. */
  readonly linkCompanion: () => void;
  /** Whether a call she is on is up: main keeps the window drawing for her while she shows. */
  readonly feedingCompanion: (feeding: boolean) => void;
  /** Hands `callback` each pick from her menu that main sends for the call. */
  readonly onCompanionPick: (callback: (pick: CompanionCallPick) => void) => void;
  /**
   * Hands `callback` whether the window shows, now and at each change: hidden while it feeds her, its
   * page still runs, as throttling's off.
   */
  readonly onWindowShows: (callback: (shows: boolean) => void) => void;
  /** Hands `callback` the updater's state, now and at each change. */
  readonly onUpdateState: (callback: (state: UpdateState) => void) => void;
  /** Checks the update feed, surfacing skipped versions and reporting the outcome. */
  readonly updateCheck: () => Promise<UpdateCheckOutcome>;
  /** Starts or retries downloading the offered update. */
  readonly updateDownload: () => Promise<void>;
  /** Restarts to install the downloaded update. */
  readonly updateInstall: () => Promise<void>;
  /** Skips the offered version so quiet launch checks stay silent about it. */
  readonly updateSkip: () => Promise<void>;
  /** OS permissions relevant to LAPLACE Eidolon on this computer. */
  readonly permissions: () => Promise<PermissionsState>;
  /** Prompts macOS for access or opens the OS settings pane when already decided. */
  readonly requestPermission: (id: PermissionId) => Promise<PermissionRequestResult>;
  /** Opens the OS settings pane for `id`. */
  readonly openPermissionSettings: (id: PermissionId) => Promise<boolean>;
  /** Tests a LAN TCP connection via Electron's Node runtime. */
  readonly testLocalNetwork: (target: LocalNetworkTestRequest) => Promise<LocalNetworkTestResult>;
}

/** `window.eidolonShell`, on the shell pages alone: the failure page's buttons. */
export interface EidolonShell {
  readonly retry: () => void;
  readonly showLogs: () => void;
  readonly quit: () => void;
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
