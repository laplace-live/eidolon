// Electron's calls that could put something in front of the owner, through background mode's
// (background.ts): with EIDOLON_DESKTOP_BACKGROUND on, each is logged and nothing shows.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { app, dialog, Menu, Notification, type Session, shell } from "electron";
import { DOWNLOADS_FOLDER, DownloadPaths, type NoticeEvents, nativeUi } from "./background.ts";
import { background } from "./instance.ts";
import { mainLog } from "./log.ts";
import { loggedUrl } from "./policy.ts";
import { windowsToastXml } from "./toast-xml.ts";

interface MacNotifyAddon {
  init(onClick: (id: string) => void, onFailed: (id: string, error: string) => void): void;
  show(options: {
    id: string;
    title: string;
    subtitle?: string;
    body: string;
    threadId?: string;
    senderId?: string;
    senderName?: string;
    avatarPath?: string;
    groupTitle?: string;
  }): void;
  close(id: string): void;
}

const MAX_MAC_PENDING = 64;
const macPending = new Map<string, NoticeEvents>();
let macAddon: MacNotifyAddon | null | undefined;

function macNotifyPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "native", "mac_notify.node");
  const candidates = [
    join(app.getAppPath(), "dist", "native", "mac_notify.node"),
    join(app.getAppPath(), "native", "mac_notify.node"),
    join(app.getAppPath(), "..", "native", "mac_notify.node"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? (candidates[0] as string);
}

function loadMacNotify(): MacNotifyAddon | null {
  if (process.platform !== "darwin") return null;
  if (macAddon !== undefined) return macAddon;
  const addonPath = macNotifyPath();
  try {
    const req = createRequire(import.meta.url);
    const loaded = req(addonPath) as MacNotifyAddon;
    loaded.init(
      (id) => {
        const target = macPending.get(id);
        macPending.delete(id);
        target?.click();
      },
      (id, error) => {
        const target = macPending.get(id);
        macPending.delete(id);
        target?.failed(error);
      },
    );
    macAddon = loaded;
  } catch (error) {
    mainLog.warn(
      `Eidolon: couldn't load macOS native notification addon (${addonPath}); falling back to Electron Notification: ${String(error)}`,
    );
    macAddon = null;
  }
  return macAddon;
}

export const native = nativeUi(
  background,
  {
    messageBox: (box) => dialog.showMessageBox(box),
    openExternal: (url) => shell.openExternal(url),
    openPath: (path) => shell.openPath(path),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    aboutPanel: (panel) => {
      app.setAboutPanelOptions(panel);
      app.showAboutPanel();
    },
    stealFocus: () => app.focus({ steal: true }),
    popup: (menu, options) => Menu.buildFromTemplate([...menu]).popup(options),
    chooseFolder: async (window, options) => {
      // A window makes it a sheet on macOS.
      const { canceled, filePaths } = await (window === null
        ? dialog.showOpenDialog(options)
        : dialog.showOpenDialog(window, options));
      return canceled ? null : (filePaths[0] ?? null);
    },
    notify: (notice, events) => {
      const avatarPath = notice.group?.avatarPath ?? notice.sender?.avatarPath;
      if (process.platform === "darwin") {
        const addon = loadMacNotify();
        if (addon !== null) {
          const id = `eidolon:${randomUUID()}`;
          if (macPending.size >= MAX_MAC_PENDING) {
            const oldest = macPending.keys().next().value;
            if (oldest !== undefined) macPending.delete(oldest);
          }
          macPending.set(id, events);
          try {
            const threadId = notice.threadId ?? notice.group?.id;
            addon.show({
              id,
              title: notice.title ?? "",
              ...(notice.subtitle !== undefined ? { subtitle: notice.subtitle } : {}),
              body: notice.body ?? "",
              ...(threadId !== undefined ? { threadId } : {}),
              ...(notice.sender !== undefined
                ? { senderId: notice.sender.id, senderName: notice.sender.name }
                : {}),
              ...(avatarPath !== undefined ? { avatarPath } : {}),
              ...(notice.group !== undefined ? { groupTitle: notice.group.title } : {}),
            });
            return {
              close: () => {
                macPending.delete(id);
                addon.close(id);
              },
            };
          } catch (error) {
            macPending.delete(id);
            mainLog.warn(
              `Eidolon: mac_notify.show failed, falling back to Electron Notification: ${String(error)}`,
            );
          }
        }
      }
      const notification =
        process.platform === "win32"
          ? new Notification({
              title: notice.title ?? "",
              body: notice.body ?? "",
              toastXml: windowsToastXml(notice),
            })
          : new Notification({
              ...(notice.title !== undefined ? { title: notice.title } : {}),
              ...(notice.subtitle !== undefined ? { subtitle: notice.subtitle } : {}),
              ...(notice.body !== undefined ? { body: notice.body } : {}),
              ...(avatarPath !== undefined ? { icon: avatarPath } : {}),
            });
      notification.on("click", () => events.click());
      notification.on("failed", (_event, error) => events.failed(error));
      notification.show();
      return { close: () => notification.close() };
    },
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
