// Runs sandboxed before each page in the window. It marks the page with the window controls it
// sits beside, before its first paint, for apps/web's [data-shell] styles, and gives the app's
// page and the shell pages each its own bridge to main.
import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE, versionsFrom } from "../shared/bridge.ts";
import { bridgeFor, desktopBridge, shellBridge } from "./bridges.ts";

const marks = { shell: process.platform === "darwin" ? "mac" : "win", fullscreen: false };

function mark(root: HTMLElement): void {
  root.dataset.shell = marks.shell;
  root.toggleAttribute("data-fullscreen", marks.fullscreen);
}

// A preload runs before the parser has created <html>: the marks go on as it's inserted.
new MutationObserver((_records, observer) => {
  if (document.documentElement === null) return;
  mark(document.documentElement);
  observer.disconnect();
}).observe(document, { childList: true });

// Fullscreen hides the traffic lights, and the page's insets for them go with them.
if (process.platform === "darwin") {
  ipcRenderer.on(BRIDGE.fullscreen, (_event, fullscreen: unknown) => {
    marks.fullscreen = fullscreen === true;
    if (document.documentElement !== null) mark(document.documentElement);
  });
}

const page = bridgeFor(location.href, process.isMainFrame);
if (page === "app") {
  contextBridge.exposeInMainWorld(
    "eidolonDesktop",
    desktopBridge(ipcRenderer, process.platform, versionsFrom(process.argv)),
  );
} else if (page === "shell") {
  contextBridge.exposeInMainWorld("eidolonShell", shellBridge(ipcRenderer));
}
