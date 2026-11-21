// The application menu and the window's context menu, in the shell's language: menus.ts holds
// them as data.
import { app, BrowserWindow, Menu, type WebContents } from "electron";
import { contextMenu, type MenuActions, macMenu, windowsMenu } from "./menus.ts";
import type { Strings } from "./strings.ts";

/** Sets the application menu; again whenever the shell's language changes. */
export function setApplicationMenu(strings: Strings, actions: MenuActions): void {
  const template =
    process.platform === "darwin"
      ? macMenu(strings, actions, { packaged: app.isPackaged })
      : windowsMenu(strings);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Electron has no context menu of its own: cut, copy and paste for fields and selected text. */
export function attachContextMenu(contents: WebContents, strings: () => Strings): void {
  contents.on("context-menu", (_event, params) => {
    const items = contextMenu(strings(), params);
    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({
      window: BrowserWindow.fromWebContents(contents) ?? undefined,
      frame: params.frame ?? undefined,
    });
  });
}
