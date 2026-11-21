// The logs (§5.7, D11): main's own in main.log and the backend's output in backend.log, both in
// app.getPath("logs"), which instance.ts has moved into a profile given on the command line.
// console goes to main.log too, electron-updater's included.
import { mkdirSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import log from "electron-log/main";
import { LOG_MAX_BYTES, rotate } from "./log-files.ts";

type FileLogger = typeof log;

function writeTo(logger: FileLogger, fileName: string): void {
  const file = logger.transports.file;
  file.resolvePathFn = () => join(app.getPath("logs"), fileName);
  file.level = "info";
  file.maxSize = LOG_MAX_BYTES;
  file.archiveLogFn = (old) => rotate(old.path);
  // On by default in dev: every line sent to every window, for a listener none has.
  logger.transports.ipc.level = false;
}

// Never log.initialize(): it would inject electron-log's own preload into every session.
writeTo(log, "main.log");

/** The backend's stdout and stderr, but the two lines with a link code (log-filter.ts). */
export const backendLog: FileLogger = log.create({ logId: "backend" });
writeTo(backendLog, "backend.log");
// Its lines carry their own levels.
backendLog.transports.file.format = "[{y}-{m}-{d} {h}:{i}:{s}.{ms}] {text}";
// In a terminal (dev) they show beside main's; a packaged app's stdout goes nowhere.
backendLog.transports.console.level = app.isPackaged ? false : "info";

export const mainLog = log;
Object.assign(console, log.functions);
// An uncaught error in main goes to main.log, not to Electron's own box over the app.
log.errorHandler.startCatching({ showDialog: false });

app.on("render-process-gone", (_event, contents, details) => {
  log.error(
    `Eidolon: a renderer is gone (${details.reason}, exit code ${details.exitCode}) at ${contents.getURL()}`,
  );
});
app.on("child-process-gone", (_event, details) => {
  log.error(
    `Eidolon: Electron's ${details.type} process is gone (${details.reason}, exit code ${details.exitCode})`,
  );
});

/** The folder Show Logs opens, made if a first run has written nothing yet. */
export function logsFolder(): string {
  const folder = app.getPath("logs");
  mkdirSync(folder, { recursive: true });
  return folder;
}

/** One line naming the app, its build and the machine, at the top of each run's log. */
export function logStart(version: string): void {
  const { electron, chrome, node } = process.versions;
  log.info(
    `Eidolon ${version}${app.isPackaged ? "" : " (unpackaged)"} · Electron ${electron} · Chromium ${chrome} · Node ${node} · ${process.platform} ${release()} ${process.arch}`,
  );
}
