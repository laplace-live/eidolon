// This launch's profile, its logs folder and the single-instance lock. index.ts imports it first, so
// all three are settled before any other module can touch userData or start a log.
import { join } from "node:path";
import { app } from "electron";

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

/** False when another instance holds this profile, which gets `request` as `second-instance`. */
export const primary = app.requestSingleInstanceLock(request);
