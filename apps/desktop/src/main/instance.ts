// This launch's profile, its logs folder and the single-instance lock. index.ts imports it first, so
// all three are settled before any other module can touch userData or start a log; a packaged
// launch with a debugging switch exits before any of them. Background mode is settled first of all.
import { join } from "node:path";
import { app } from "electron";
import { activationPolicy, backgroundMode } from "./background.ts";
import { refuseDebugging } from "./navigation.ts";

/** EIDOLON_DESKTOP_BACKGROUND: nothing this run does shows on screen or takes the focus. */
export const background = backgroundMode(process.env);
// As early as main's code can: macOS registers each launch as a regular app, Dock icon included,
// before any of it runs (only LSUIElement in Info.plist would start it as an accessory).
const policy = activationPolicy(process.platform, background);
if (policy !== null) app.setActivationPolicy(policy);

/** What a launch asks of the instance already running: --quit quits it, as the tray's Quit does. */
export interface LaunchRequest {
  readonly command: "show" | "quit";
}

export const request: LaunchRequest = {
  command: process.argv.includes("--quit") ? "quit" : "show",
};

export function isLaunchRequest(data: unknown): data is LaunchRequest {
  const command = (data as Partial<LaunchRequest> | null)?.command;
  return command === "show" || command === "quit";
}

/** A packaged launch with a switch that opens CDP is exiting; nothing else runs. */
export const refused = refuseDebugging();

if (!refused) {
  // productName's profile, and the lock it scopes, are the installed app's. A launch given
  // --user-data-dir (the smokes) keeps it: setPath would replace it.
  if (!app.isPackaged && !app.commandLine.hasSwitch("user-data-dir")) {
    app.setPath("userData", join(app.getPath("appData"), "Eidolon Dev"));
  }
  // On macOS the logs folder is ~/Library/Logs/<productName> whatever the profile, so a dev or smoke
  // run would append to the installed app's logs.
  if (app.getPath("userData") !== join(app.getPath("appData"), app.getName())) {
    app.setAppLogsPath(join(app.getPath("userData"), "logs"));
  }
}

/** False when another instance holds this profile, which gets `request` as `second-instance`. */
export const primary = !refused && app.requestSingleInstanceLock(request);
