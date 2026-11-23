// The desktop options that change the owner's system, Open at Login and the terminal command: which
// copies of the app may offer them, and Open at Login as the OS reads and writes it. Each changes
// only on the owner's click in Settings. Electron-free: index.ts hands it Electron's answers.
import type { LoginItemSettings, LoginItemSettingsOptions, Settings } from "electron";
import type { LoginItemState, Unavailable } from "../shared/bridge.ts";

export interface AppCopy {
  readonly background: boolean;
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  /** macOS: app.isInApplicationsFolder(). */
  readonly inApplications: boolean;
  /** Windows: NSIS's per-user install (update-flow.ts's isUpdatableInstall). */
  readonly installedCopy: boolean;
}

/**
 * Why this copy can't offer the options, or null when it can. Background mode changes nothing on
 * the owner's system. A login item or a link to a copy that moves, or that an update replaces
 * elsewhere, would start or run the wrong app.
 */
export function optionsUnavailable({
  background,
  packaged,
  platform,
  inApplications,
  installedCopy,
}: AppCopy): Unavailable | null {
  if (background) return "background";
  if (!packaged) return "unpackaged";
  if (platform === "darwin" && !inApplications) return "outside-applications";
  if (platform === "win32" && !installedCopy) return "not-installed";
  return null;
}

/** On Windows, the login item's switch, which tells a launch at login from the owner's. */
export const LOGIN_SWITCH = "--opened-at-login";

/** What getLoginItemSettings compares with: on Windows, the Run entry's arguments, exactly. */
export function loginItemQuery(platform: NodeJS.Platform): LoginItemSettingsOptions {
  return platform === "win32" ? { args: [LOGIN_SWITCH] } : {};
}

/**
 * setLoginItemSettings's settings. macOS registers the app itself through SMAppService: Electron 44
 * dropped the hidden-launch flag, so a launch at login tells itself apart by wasOpenedAtLogin.
 */
export function loginItemWrite(platform: NodeJS.Platform, on: boolean): Settings {
  return platform === "win32" ? { openAtLogin: on, args: [LOGIN_SWITCH] } : { openAtLogin: on };
}

/** What Open at Login's state reads of getLoginItemSettings' answer. */
export type LoginItemRead = Pick<
  LoginItemSettings,
  "openAtLogin" | "status" | "executableWillLaunchAtLogin"
>;

/**
 * Open at Login as the OS has it; `read` runs only when this copy may offer it. On Windows an entry
 * turned off in Startup apps reads as off, and Turn On enables it again, as Electron's write does.
 */
export function loginItemState(
  platform: NodeJS.Platform,
  unavailable: Unavailable | null,
  read: () => LoginItemRead,
): LoginItemState {
  if (unavailable !== null) return { state: "unavailable", reason: unavailable };
  const settings = read();
  if (platform === "darwin") {
    switch (settings.status) {
      case "enabled":
        return { state: "on" };
      case "requires-approval":
        return { state: "needs-approval" };
      // SMAppService couldn't find the app to register.
      case "not-found":
        return { state: "unavailable", reason: "outside-applications" };
      default:
        return { state: "off" };
    }
  }
  return settings.openAtLogin && settings.executableWillLaunchAtLogin
    ? { state: "on" }
    : { state: "off" };
}

/** Whether this launch is the login item's: Windows passes the switch, and macOS says so itself. */
export function openedAtLogin(
  platform: NodeJS.Platform,
  argv: readonly string[],
  wasOpenedAtLogin: boolean,
): boolean {
  return platform === "win32" ? argv.includes(LOGIN_SWITCH) : wasOpenedAtLogin;
}
