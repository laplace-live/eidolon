// The window never leaves eidolon-app://: a web link opens in the default browser, a
// link to the app's own files saves through a download, no window ever opens, and a navigation or a
// redirect anywhere else is cancelled. A packaged app also refuses the switches that open CDP.
// instance.ts runs that refusal before the profile and the logs exist, so this loads no logger.
import { app, type WebContents } from "electron";
import {
  leftTheApp,
  loggedUrl,
  mayRedirect,
  navigationAction,
  openAction,
  refusesDebugging,
} from "./policy.ts";

export interface NavigationGuard {
  readonly log: { info(message: string): void; warn(message: string): void };
  /** The default browser's, as native.ts gives it. */
  readonly openExternal: (url: string) => Promise<void>;
  /** Puts main's page back when the main frame lands somewhere no navigation event could stop. */
  readonly strayed: () => void;
}

/** Guards the window's webContents. */
export function guardNavigation(
  contents: WebContents,
  { log, openExternal, strayed }: NavigationGuard,
): void {
  const openInBrowser = (url: string): void => {
    openExternal(url).catch((error: unknown) => {
      log.warn(`Eidolon: the default browser didn't open a link: ${String(error)}`);
    });
  };
  contents.setWindowOpenHandler(({ url }) => {
    const action = openAction(url);
    if (action === "browser") {
      openInBrowser(url);
    } else if (action === "download") {
      // The window has no tabs: a picture or file the page opens in one saves instead, through
      // Electron's Save dialog, or in background mode quietly (native.ts).
      contents.downloadURL(url);
    } else {
      const scheme = URL.parse(url)?.protocol ?? "an unreadable URL";
      log.info(`Eidolon: refused to open a window on ${scheme}`);
    }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => {
    const action = navigationAction(event.url);
    if (action === "allow") return;
    event.preventDefault();
    if (action === "browser") openInBrowser(event.url);
  });
  contents.on("will-redirect", (event) => {
    if (mayRedirect(event.url)) return;
    event.preventDefault();
    log.warn("Eidolon: cancelled a redirect away from the app");
  });
  // Emitted for the main frame alone, and never for an error page.
  contents.on("did-navigate", (_event, url) => {
    if (!leftTheApp(url)) return;
    log.warn(`Eidolon: the window left the app for ${loggedUrl(url)}; showing it again`);
    strayed();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

/**
 * Exits a packaged app started with --remote-debugging-port or --remote-debugging-pipe, which no
 * fuse covers; true when it does.
 */
export function refuseDebugging(): boolean {
  const refused = refusesDebugging(app.isPackaged, (name) => app.commandLine.hasSwitch(name));
  if (refused) app.exit(1);
  return refused;
}
