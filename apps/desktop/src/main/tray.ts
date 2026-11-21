// Windows' notification-area icon: Windows has no Dock to bring a hidden window back, so
// the icon stays for the whole run, opens the window on a click, and holds the items macOS's menu
// bar has.
import { join } from "node:path";
import { app, Menu, nativeImage, Tray } from "electron";
import { type TrayActions, trayMenu } from "./menus.ts";
import type { Strings } from "./strings.ts";

/** The icon's .ico, which `extraResources` ships beside the app; resources/ is never packed. */
export function trayIconPath(): string {
  const assets = app.isPackaged
    ? join(process.resourcesPath, "assets")
    : join(app.getAppPath(), "assets");
  return join(assets, "tray-icon.ico");
}

export class AppTray {
  readonly #tray: Tray;
  readonly #actions: TrayActions;

  constructor(strings: Strings, actions: TrayActions) {
    this.#tray = new Tray(nativeImage.createFromPath(trayIconPath()));
    this.#actions = actions;
    this.#tray.on("click", () => actions.open());
    this.relabel(strings);
  }

  /** Its tooltip and menu, in the shell's language. */
  relabel(strings: Strings): void {
    if (this.#tray.isDestroyed()) return;
    this.#tray.setToolTip(strings.label.trayTooltip);
    this.#tray.setContextMenu(Menu.buildFromTemplate(trayMenu(strings, this.#actions)));
  }

  /** Once a quit is under way, so no dead icon outlives the process. */
  destroy(): void {
    if (!this.#tray.isDestroyed()) this.#tray.destroy();
  }
}
