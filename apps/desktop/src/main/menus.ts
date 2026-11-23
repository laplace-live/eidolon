// The shell's menus as data: macOS's application menu, Windows' (zoom alone, under a
// hidden title bar) and its tray icon's, the context menu Electron doesn't have, and the About
// panel they open. Electron-free: menu.ts, tray.ts and index.ts hand them to Electron.
import type { AboutPanelOptionsOptions, MenuItemConstructorOptions } from "electron";
import type { DesktopVersions } from "../shared/bridge.ts";
import type { Strings } from "./strings.ts";
import type { UpdateState } from "./update-flow.ts";

/** What the menus' own items do; the rest are Electron's roles. */
export interface MenuActions {
  /** Brings the window forward and opens the page's Settings. */
  readonly settings: () => void;
  readonly checkForUpdates: () => void;
  readonly showLogs: () => void;
  readonly openDataFolder: () => void;
  readonly licenses: () => void;
  readonly about: () => void;
}

/** Check for Updates… as the updater stands. */
export type UpdatesItem = "enabled" | "disabled" | "hidden";

/**
 * Absent while this run doesn't update itself, unless it runs from a read-only volume, whose box
 * says to move it; disabled while a check, a download or the restart runs.
 */
export function updatesItem(phase: UpdateState["phase"]): UpdatesItem {
  if (phase === "unsupported") return "hidden";
  return phase === "checking" || phase === "downloading" || phase === "installing"
    ? "disabled"
    : "enabled";
}

function checkForUpdates(
  { label }: Strings,
  actions: MenuActions,
  updates: UpdatesItem,
): MenuItemConstructorOptions[] {
  if (updates === "hidden") return [];
  return [
    {
      label: label.checkForUpdates,
      enabled: updates === "enabled",
      click: () => actions.checkForUpdates(),
    },
  ];
}

/** The tray's items, beside the menus'. */
export interface TrayActions extends MenuActions {
  readonly open: () => void;
  readonly quit: () => void;
}

/** What Electron's context-menu event says of the press. */
export interface ContextParams {
  readonly isEditable: boolean;
  readonly selectionText: string;
  readonly editFlags: {
    readonly canCut: boolean;
    readonly canCopy: boolean;
    readonly canPaste: boolean;
    readonly canSelectAll: boolean;
  };
}

const separator = (): MenuItemConstructorOptions => ({ type: "separator" });

/**
 * macOS's menu bar, declared in full since a custom menu replaces Electron's default: without the
 * Edit roles, copy and paste break. ⌘W's close hides the window (quit.ts). In background mode, About
 * is the app's own action, which logs the panel, and the developer tools, a window, aren't offered.
 */
export function macMenu(
  strings: Strings,
  actions: MenuActions,
  {
    packaged,
    background,
    updates,
  }: { readonly packaged: boolean; readonly background: boolean; readonly updates: UpdatesItem },
): MenuItemConstructorOptions[] {
  const { label } = strings;
  return [
    {
      label: "Eidolon",
      submenu: [
        background
          ? { label: label.aboutEidolon, click: () => actions.about() }
          : { role: "about", label: label.aboutEidolon },
        ...checkForUpdates(strings, actions, updates),
        separator(),
        { label: label.settings, accelerator: "Command+,", click: () => actions.settings() },
        separator(),
        { role: "services", label: label.services },
        separator(),
        { role: "hide", label: label.hideEidolon },
        { role: "hideOthers", label: label.hideOthers },
        { role: "unhide", label: label.showAll },
        separator(),
        { role: "quit", label: label.quitEidolon },
      ],
    },
    {
      label: label.editMenu,
      submenu: [
        { role: "undo", label: label.undo },
        { role: "redo", label: label.redo },
        separator(),
        { role: "cut", label: label.cut },
        { role: "copy", label: label.copy },
        { role: "paste", label: label.paste },
        { role: "pasteAndMatchStyle", label: label.pasteAndMatchStyle },
        { role: "delete", label: label.delete },
        { role: "selectAll", label: label.selectAll },
      ],
    },
    {
      label: label.viewMenu,
      submenu: [
        { role: "resetZoom", label: label.actualSize },
        { role: "zoomIn", label: label.zoomIn },
        { role: "zoomOut", label: label.zoomOut },
        separator(),
        { role: "togglefullscreen", label: label.toggleFullScreen },
        ...(packaged || background
          ? []
          : [separator(), { role: "toggleDevTools", label: label.toggleDevTools } as const]),
      ],
    },
    {
      label: label.windowMenu,
      role: "window",
      submenu: [
        { role: "minimize", label: label.minimize },
        { role: "zoom", label: label.zoom },
        separator(),
        { role: "close", label: label.closeWindow },
        separator(),
        { role: "front", label: label.bringAllToFront },
      ],
    },
    {
      label: label.helpMenu,
      role: "help",
      submenu: [
        { label: label.showLogs, click: () => actions.showLogs() },
        { label: label.openDataFolder, click: () => actions.openDataFolder() },
        { label: label.licenses, click: () => actions.licenses() },
      ],
    },
  ];
}

/**
 * Windows shows no menu bar under the hidden title bar, but Electron installs its default menu for
 * an app that sets none, and its accelerators act even then: only zoom's stay.
 */
export function windowsMenu({ label }: Strings): MenuItemConstructorOptions[] {
  return [
    {
      label: label.viewMenu,
      submenu: [
        { role: "resetZoom", label: label.actualSize },
        { role: "zoomIn", label: label.zoomIn },
        { role: "zoomOut", label: label.zoomOut },
      ],
    },
  ];
}

/** The tray's menu on Windows, which holds what macOS's menu bar does. */
export function trayMenu(
  strings: Strings,
  actions: TrayActions,
  updates: UpdatesItem,
): MenuItemConstructorOptions[] {
  const { label } = strings;
  return [
    { label: label.openEidolon, click: () => actions.open() },
    { label: label.settings, click: () => actions.settings() },
    ...checkForUpdates(strings, actions, updates),
    separator(),
    { label: label.showLogs, click: () => actions.showLogs() },
    { label: label.openDataFolder, click: () => actions.openDataFolder() },
    { label: label.licenses, click: () => actions.licenses() },
    { label: label.aboutEidolon, click: () => actions.about() },
    separator(),
    { label: label.quitEidolon, click: () => actions.quit() },
  ];
}

/** Cut, copy, paste and select all in a field; copy over selected text; nothing elsewhere. */
export function contextMenu(
  { label }: Strings,
  { isEditable, selectionText, editFlags }: ContextParams,
): MenuItemConstructorOptions[] {
  if (isEditable) {
    return [
      { role: "cut", label: label.cut, enabled: editFlags.canCut },
      { role: "copy", label: label.copy, enabled: editFlags.canCopy },
      { role: "paste", label: label.paste, enabled: editFlags.canPaste },
      separator(),
      { role: "selectAll", label: label.selectAll, enabled: editFlags.canSelectAll },
    ];
  }
  if (selectionText.length > 0) {
    return [{ role: "copy", label: label.copy, enabled: editFlags.canCopy }];
  }
  return [];
}

/**
 * The About panel: the app's own version, and the server's beside it once one has answered,
 * which may be a terminal's of another version. macOS shows it beside the app's, Windows among
 * the credits.
 */
export function aboutPanel(
  platform: NodeJS.Platform,
  { version, serverVersion }: DesktopVersions,
  { text }: Strings,
  iconPath: string,
): AboutPanelOptionsOptions {
  const server = serverVersion === "" ? "" : text.aboutServer(serverVersion);
  const panel = { applicationName: "Eidolon", applicationVersion: version };
  return platform === "darwin"
    ? { ...panel, version: server }
    : { ...panel, credits: server, iconPath };
}
