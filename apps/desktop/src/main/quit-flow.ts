// Closing and quitting: a close hides the window, and every quit, from ⌘Q, a menu, the
// Dock, the tray or a second launch's --quit, goes through one flow: ask when work or unsaved edits
// would be cut, hide, stop our own backend, then let the quit through. The restart that installs an update goes
// the same way. Electron-free: quit.ts wires it to the app's events, and the confirmation
// (quit-check.ts) decides whether to ask.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { QuitPurpose } from "./quit-check.ts";

export interface QuitEffects {
  /** The quit check and its box; true to go ahead. Asked again while open, it joins the open box. */
  readonly confirm: (purpose: QuitPurpose) => Promise<boolean>;
  readonly hideWindows: () => void;
  /** The stop of our own backend; nothing for an attached server. */
  readonly stopBackend: () => Promise<void>;
  /** app.quit(), which runs before-quit again, now let through. */
  readonly quit: () => void;
  readonly log: { info(message: string): void; error(message: string): void };
}

export class QuitFlow {
  readonly #effects: QuitEffects;
  #phase: "running" | "asking" | "stopping" | "done" = "running";
  /** macOS's power-off notice, which another app can still cancel: until the window's next focus. */
  #poweringOff = false;

  constructor(effects: QuitEffects) {
    this.#effects = effects;
  }

  /** Once the quit is approved: windows close rather than hide, and nothing asks again. */
  get quitting(): boolean {
    return this.#phase === "stopping" || this.#phase === "done";
  }

  /** A window's close: hide it instead, unless the app is quitting. */
  closeHides(): boolean {
    return !this.quitting;
  }

  /**
   * before-quit, from any source: true lets this quit through, which only the flow's own last quit
   * is. The first starts the flow; one while the box is open joins it.
   */
  beforeQuit(): boolean {
    if (this.#phase === "done") return true;
    if (this.#phase === "asking") void this.#effects.confirm("quit");
    if (this.#phase === "running") void this.#run("quit", () => this.#effects.quit());
    return false;
  }

  /**
   * The restart that installs an update, `install` being quitAndInstall: the quit's check, with a
   * box naming what a restart stops, its latch and its stop, then `install` in place of the quit.
   * `installable` is asked once the check lets it through, before the latch: the update can fail
   * while the box is open. Never from before-quit: on macOS quitAndInstall closes every window
   * before before-quit fires, so a latch set there lets the hide-on-close window veto the
   * relaunch. False when it didn't go ahead: cancelled, no longer installable, or a quit was
   * already under way, whose box comes forward.
   */
  restart(install: () => void, installable: () => boolean): Promise<boolean> {
    if (this.#phase === "asking") void this.#effects.confirm("quit");
    if (this.#phase !== "running") return Promise.resolve(false);
    return this.#run("restart", install, installable);
  }

  /** macOS's powerMonitor shutdown: the system powers off, so the quit that follows doesn't ask. */
  poweringOff(): void {
    this.#poweringOff = true;
  }

  /** The window has the owner's attention again: a power-off that was cancelled doesn't count. */
  attention(): void {
    this.#poweringOff = false;
  }

  /** Windows' session-end: Electron ends the process at once after it, and nothing may hold it. */
  sessionEnded(): void {
    this.#phase = "done";
  }

  /** True once `finish` ran: the quit, or the update's install. */
  async #run(
    purpose: QuitPurpose,
    finish: () => void,
    proceed: () => boolean = () => true,
  ): Promise<boolean> {
    this.#phase = "asking";
    let approved: boolean;
    try {
      approved = this.#poweringOff || (await this.#effects.confirm(purpose));
    } catch (error) {
      this.#effects.log.error(`Eidolon: the quit check failed, quitting anyway: ${String(error)}`);
      approved = true;
    }
    if (this.#phase !== "asking") return false;
    if (!approved || !proceed()) {
      this.#phase = "running";
      return false;
    }
    this.#phase = "stopping";
    this.#effects.log.info(
      purpose === "restart" ? "Eidolon: quitting to install the update" : "Eidolon: quitting",
    );
    this.#effects.hideWindows();
    try {
      await this.#effects.stopBackend();
    } catch (error) {
      this.#effects.log.error(`Eidolon: stopping the backend failed: ${String(error)}`);
    }
    this.#phase = "done";
    finish();
    return true;
  }
}

/**
 * Windows' one-time notice, the first time a close only hides the window: it is in the tray. A
 * marker in userData keeps it from showing again.
 */
export class HideNotice {
  readonly #marker: string;
  readonly #show: () => Promise<unknown>;
  readonly #log: { warn(message: string): void };
  #shown = false;

  constructor(options: {
    readonly marker: string;
    readonly show: () => Promise<unknown>;
    readonly log: { warn(message: string): void };
  }) {
    this.#marker = options.marker;
    this.#show = options.show;
    this.#log = options.log;
  }

  /** After a hide: shows the notice unless it has shown before, here or in an earlier run. */
  hidden(): void {
    if (this.#shown || existsSync(this.#marker)) return;
    this.#shown = true;
    try {
      mkdirSync(dirname(this.#marker), { recursive: true });
      writeFileSync(this.#marker, "");
    } catch (error) {
      this.#log.warn(`Eidolon: couldn't record that the tray notice showed: ${String(error)}`);
    }
    this.#show().catch((error: unknown) => {
      this.#log.warn(`Eidolon: the tray notice didn't show: ${String(error)}`);
    });
  }
}
