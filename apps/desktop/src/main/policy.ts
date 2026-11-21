// What the window may do (§1.4, §1.9, §5.5): where a link opens and a navigation goes, which
// permissions its page gets, and whether a packaged app may start with a debugging switch.
// Electron-free: navigation.ts, permissions.ts and instance.ts apply it.
import { pageAt, SCHEME } from "../shared/bridge.ts";

/** What a link the page opens in a new window becomes; no window ever opens. */
export type OpenAction = "browser" | "download" | "deny";

/** What a navigation the page starts becomes. */
export type NavigationAction = "allow" | "browser" | "deny";

/** What main does with a permission request from the page. */
export type RequestAction =
  /** Granted as asked: a clipboard write. */
  | "grant"
  /** The microphone: granted once the OS's own access allows it. */
  | "microphone"
  | "deny";

/** How macOS's microphone access goes on a granted request. */
export type MicrophoneStep = "grant" | "ask" | "explain";

/** The switches that open CDP, which no fuse covers. */
export const DEBUGGING_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"] as const;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isWeb(url: string): boolean {
  const protocol = parse(url)?.protocol;
  return protocol === "https:" || protocol === "http:";
}

/**
 * eidolon-app://app as Chromium serializes an origin: with or without the trailing slash, and with
 * no credentials, path, query or fragment. A sandboxed document's opaque origin is "null".
 */
export function isAppOrigin(origin: string | null | undefined): boolean {
  const url = origin ? parse(origin) : null;
  return (
    url !== null &&
    url.protocol === `${SCHEME}:` &&
    url.host === "app" &&
    url.username === "" &&
    url.password === "" &&
    (url.pathname === "" || url.pathname === "/") &&
    url.search === "" &&
    url.hash === ""
  );
}

/**
 * A link to the web goes to the default browser. One to the app's own address, such as a chat's
 * attachment, saves as a download, which carries no initiator and so gets the Bearer like main's
 * own loads; the window has no tabs to open it in. Anything else, file: included, goes nowhere.
 */
export function openAction(url: string): OpenAction {
  if (isWeb(url)) return "browser";
  return pageAt(url) === "app" ? "download" : "deny";
}

/** The page stays on the app's address; a link out to the web opens in the default browser. */
export function navigationAction(url: string): NavigationAction {
  if (pageAt(url) === "app") return "allow";
  return isWeb(url) ? "browser" : "deny";
}

/** A redirect, during the page's navigation or main's own load, stays on the app's address. */
export function mayRedirect(url: string): boolean {
  return pageAt(url) === "app";
}

/** Who asked for a permission, as the request handler sees it. */
export interface PermissionAsker {
  /** Whether the request came from the app window's webContents. */
  readonly window: boolean;
  readonly mainFrame: boolean;
  /** For `media`: what it asks for. */
  readonly mediaTypes?: readonly string[];
  /** For `media`: the requesting frame's origin. */
  readonly securityOrigin?: string;
  /** The main frame's origin, for a request that carries no origin of its own. */
  readonly frameOrigin: string | null;
}

/**
 * The microphone goes only to the app window's main frame at eidolon-app://app, audio alone, and
 * clipboard writes only to that frame too; everything else, the camera included, is denied.
 */
export function requestAction(permission: string, asker: PermissionAsker): RequestAction {
  if (!asker.window || !asker.mainFrame) return "deny";
  if (permission === "media") {
    const types = asker.mediaTypes ?? [];
    return types.length === 1 && types[0] === "audio" && isAppOrigin(asker.securityOrigin)
      ? "microphone"
      : "deny";
  }
  if (permission === "clipboard-sanitized-write") {
    return isAppOrigin(asker.frameOrigin) ? "grant" : "deny";
  }
  return "deny";
}

/** Most web APIs check before they request: the same two permissions pass, for the same origin. */
export function checkAllows(
  permission: string,
  requestingOrigin: string,
  details: { readonly window: boolean; readonly mediaType?: string },
): boolean {
  if (!details.window || !isAppOrigin(requestingOrigin)) return false;
  if (permission === "media") return details.mediaType === "audio";
  return permission === "clipboard-sanitized-write";
}

/**
 * After the page's request passes: Windows has no per-app prompt, and macOS asks once. Once the
 * owner has denied it, macOS never asks again, so the owner hears where to turn it on.
 */
export function microphoneStep(platform: NodeJS.Platform, status: string): MicrophoneStep {
  if (platform !== "darwin" || status === "granted") return "grant";
  return status === "denied" || status === "restricted" ? "explain" : "ask";
}

/** A packaged app started with a switch that opens CDP exits: a deterrent, as persona's is. */
export function refusesDebugging(packaged: boolean, hasSwitch: (name: string) => boolean): boolean {
  return packaged && DEBUGGING_SWITCHES.some((name) => hasSwitch(name));
}
