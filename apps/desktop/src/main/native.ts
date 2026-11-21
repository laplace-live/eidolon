// Electron's calls that could put something in front of the owner, through background mode's
// (background.ts): with EIDOLON_DESKTOP_BACKGROUND on, each is logged and nothing shows.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, dialog, Menu, type Session, shell } from "electron";
import { DOWNLOADS_FOLDER, DownloadPaths, nativeUi } from "./background.ts";
import { background } from "./instance.ts";
import { mainLog } from "./log.ts";
import { loggedUrl } from "./policy.ts";

export const native = nativeUi(
  background,
  {
    messageBox: (box) => dialog.showMessageBox(box),
    openExternal: (url) => shell.openExternal(url),
    openPath: (path) => shell.openPath(path),
    aboutPanel: (panel) => {
      app.setAboutPanelOptions(panel);
      app.showAboutPanel();
    },
    stealFocus: () => app.focus({ steal: true }),
    popup: (menu, options) => Menu.buildFromTemplate([...menu]).popup(options),
  },
  mainLog,
);

/**
 * Background mode's downloads: into the profile's downloads folder, with no Save dialog. Otherwise
 * Electron asks where, as it does with no handler.
 */
export function saveDownloads(session: Session): void {
  if (!background) return;
  const folder = join(app.getPath("userData"), DOWNLOADS_FOLDER);
  const paths = new DownloadPaths(folder, existsSync);
  session.on("will-download", (_event, item) => {
    const path = paths.next(item.getFilename());
    mkdirSync(folder, { recursive: true });
    item.setSavePath(path);
    mainLog.info(`Eidolon: background mode saves ${loggedUrl(item.getURL())} to ${path}`);
    item.once("done", (_done, state) => {
      mainLog.info(`Eidolon: background mode's download to ${path}: ${state}`);
    });
  });
}
