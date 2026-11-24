// Runs sandboxed before each page in the app's windows. It marks the page before its first paint:
// in the main window with the window controls it sits beside, for apps/web's [data-shell] styles,
// and in the desktop companion's as hers. It gives each page its own bridge to main, and hands the
// app page and hers the port main pairs them with.
import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE, versionsOf, windowKindOf } from "../shared/bridge.ts";
import { bridgeFor, companionBridge, desktopBridge, shellBridge } from "./bridges.ts";

const kind = windowKindOf(process.argv);
const marks = { shell: process.platform === "darwin" ? "mac" : "win", fullscreen: false };

function mark(root: HTMLElement): void {
  // Never the shell's marks on hers: a drag region swallows clicks, whatever their alpha.
  if (kind === "companion") {
    root.toggleAttribute("data-companion", true);
    return;
  }
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
if (process.platform === "darwin" && kind === "main") {
  ipcRenderer.on(BRIDGE.fullscreen, (_event, fullscreen: unknown) => {
    marks.fullscreen = fullscreen === true;
    if (document.documentElement !== null) mark(document.documentElement);
  });
}

const page = bridgeFor(location.href, process.isMainFrame, kind);
if (page === "app") {
  // contextBridge copies values as it exposes them, so they must be known before the page's script.
  const versions = versionsOf(ipcRenderer.sendSync(BRIDGE.versions));
  contextBridge.exposeInMainWorld(
    "eidolonDesktop",
    desktopBridge(ipcRenderer, process.platform, versions),
  );
} else if (page === "companion") {
  contextBridge.exposeInMainWorld(
    "eidolonCompanion",
    companionBridge(ipcRenderer, process.platform),
  );
} else if (page === "shell") {
  contextBridge.exposeInMainWorld("eidolonShell", shellBridge(ipcRenderer));
}

if (page === "app" || page === "companion") {
  // contextBridge copies values, so only a transfer carries a port into the page's world; "*" names
  // this same window, and the page takes only a message whose source is its own.
  ipcRenderer.on(BRIDGE.companionPort, (event) => {
    const [port] = event.ports;
    if (port) window.postMessage({ eidolon: "companion-port" }, "*", [port]);
  });
}
