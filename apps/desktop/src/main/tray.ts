// The tray's icon, for the whole run: Windows' notification-area icon, where Windows has no Dock to
// bring a hidden window back, and macOS's menu bar icon. Both hold the items macOS's menu bar has; on
// Windows a click opens the window, and on macOS a click opens the menu, as menu bar icons do.
import { join } from "node:path";
import { app, Menu, nativeImage, Tray } from "electron";
import { type TrayActions, trayMenu, type UpdatesItem } from "./menus.ts";
import type { Strings } from "./strings.ts";

/** The icons' folder, which `extraResources` ships beside the app; resources/ is never packed. */
function assets(): string {
  return app.isPackaged ? join(process.resourcesPath, "assets") : join(app.getAppPath(), "assets");
}

/** Windows' .ico, which its message boxes and About panel take too. */
export function trayIconPath(): string {
  return join(assets(), "tray-icon.ico");
}

/** macOS's template image, black on transparency for the menu bar to tint; its @2x loads beside it. */
function menuBarIconPath(): string {
  return join(assets(), "trayTemplate.png");
}

export class AppTray {
  readonly #tray: Tray;
  readonly #actions: TrayActions;

  constructor(
    strings: Strings,
    actions: TrayActions,
    updates: UpdatesItem,
    companion: boolean,
    platform: NodeJS.Platform,
  ) {
    const mac = platform === "darwin";
    const image = nativeImage.createFromPath(mac ? menuBarIconPath() : trayIconPath());
    if (mac) image.setTemplateImage(true);
    this.#tray = new Tray(image);
    this.#actions = actions;
    if (!mac) this.#tray.on("click", () => actions.open());
    this.relabel(strings, updates, companion);
  }

  /**
   * Its tooltip and menu, in the shell's language, with Check for Updates… as the updater stands
   * and Desktop Companion as she is.
   */
  relabel(strings: Strings, updates: UpdatesItem, companion: boolean): void {
    if (this.#tray.isDestroyed()) return;
    this.#tray.setToolTip(strings.label.trayTooltip);
    this.#tray.setContextMenu(
      Menu.buildFromTemplate(trayMenu(strings, this.#actions, updates, companion)),
    );
  }

  /** Once a quit is under way, so no dead icon outlives the process. */
  destroy(): void {
    if (!this.#tray.isDestroyed()) this.#tray.destroy();
  }
}
