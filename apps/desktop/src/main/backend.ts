// The backend on Electron (§2): the environment, the data home, the controller that attaches to its
// server or spawns the app's own (the packaged payload, or unpackaged the checkout's server on the
// dev Electron's node mode), backend.log, and the forwarder the app host goes through. The window
// follows its state, and learns the server's version before it shows the app.
import { join } from "node:path";
import { app } from "electron";
import { dataHome } from "./attach.ts";
import { BackendController, type BackendState, backendLaunch } from "./controller.ts";
import { startupEnvironment } from "./environment.ts";
import {
  createForwarder,
  type Forwarder,
  type SchemeRequest,
  unreachable,
  type WaitingPage,
} from "./forwarder.ts";
import { backendLog, mainLog } from "./log.ts";
import { checkQuit } from "./quit-check.ts";
import type { Stopping } from "./strings.ts";

/** The license texts the Licenses item opens, which stage-backend writes into the payload. */
export function licensesFile(): string {
  const payload = app.isPackaged
    ? join(process.resourcesPath, "eidolon")
    : join(app.getAppPath(), ".stage", `${process.platform}-${process.arch}`, "eidolon");
  return join(payload, "THIRD_PARTY_LICENSES.txt");
}

const VERSION_TIMEOUT_MS = 2_000;

export interface BackendOptions {
  /** Dev: apps/web's Vite server, for every path but the backend's own. */
  readonly devServer?: string;
  readonly waitingPage: WaitingPage;
}

export class Backend {
  readonly #options: BackendOptions;
  /** Ends a login shell's read still running at a quit: its process group outlives main. */
  readonly #abort = new AbortController();
  readonly #listeners = new Set<(state: BackendState) => void>();
  #controller: BackendController | null = null;
  #forwarder: Forwarder | null = null;
  #home: string | null = null;
  #serverVersion = "";
  #stopped = false;

  constructor(options: BackendOptions) {
    this.#options = options;
  }

  /** The controller's state; starting until the environment is read. */
  get state(): BackendState {
    return this.#controller?.state ?? { phase: "starting" };
  }

  /** The data home, once the environment has named it. */
  get home(): string | null {
    return this.#home;
  }

  /** The version the server ready last reported in its status; empty before any. */
  get serverVersion(): string {
    return this.#serverVersion;
  }

  /**
   * Calls `listener` with each state for the window to follow: a ready one only once the server's
   * version is known, so the page's bridge has it.
   */
  subscribe(listener: (state: BackendState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Reads the environment once (the login shell on macOS), resolves the data home from it, and
   * starts the controller, whose first spawn takes that same read.
   */
  async start(): Promise<void> {
    const startup = await startupEnvironment(process.env, {
      log: mainLog,
      signal: this.#abort.signal,
    });
    if (this.#stopped) return;
    const home = dataHome(startup.env);
    this.#home = home;
    mainLog.info(`Eidolon: the data home is ${home}`);
    const controller = new BackendController({
      home,
      launch: backendLaunch({
        packaged: app.isPackaged,
        execPath: process.execPath,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      }),
      environment: startup.forSpawn,
      backendLog: (_stream, line) => backendLog.info(line),
      log: mainLog,
    });
    this.#forwarder = createForwarder({
      backend: controller,
      waitingPage: this.#options.waitingPage,
      devServer: this.#options.devServer,
      log: mainLog,
    });
    this.#controller = controller;
    controller.subscribe((state) => void this.#changed(controller, state));
    controller.start();
  }

  /** The app host's requests; with no controller yet, as with no server. */
  handle(request: SchemeRequest): Promise<Response> {
    return this.#forwarder?.handle(request) ?? unreachable(request, this.#options.waitingPage);
  }

  /** Try Again after the backend failed. */
  retry(): void {
    this.#controller?.start();
  }

  /** What a quit would stop, from our own ready backend; null while attached or not ready. */
  quitCheck(): Promise<Stopping> | null {
    const forwarder = this.#forwarder;
    const state = this.state;
    if (forwarder === null || state.phase !== "ready" || !state.owned) return null;
    return checkQuit((path, { signal }) => forwarder.get(path, signal));
  }

  /** §2.4's stop: our own backend only, never an attached server. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort.abort();
    await this.#controller?.stop();
    await this.#forwarder?.destroy();
  }

  /** Windows' query-session-end: the stop trigger alone. */
  sessionEnding(): void {
    this.#controller?.sessionEnding();
  }

  /** Windows' session-end: waits, blocking, for the exit sessionEnding started. */
  sessionEnded(): void {
    this.#controller?.sessionEnded();
  }

  async #changed(controller: BackendController, state: BackendState): Promise<void> {
    if (state.phase === "ready") {
      await this.#readVersion();
      // It moved on meanwhile, and that state has been told already.
      if (controller.state !== state) return;
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch (error) {
        mainLog.error(`Eidolon: following the backend failed: ${String(error)}`);
      }
    }
  }

  /** The status's version: the server shown may be a terminal's of another version. */
  async #readVersion(): Promise<void> {
    const forwarder = this.#forwarder;
    if (forwarder === null) return;
    try {
      const response = await forwarder.get(
        "/api/local/status",
        AbortSignal.timeout(VERSION_TIMEOUT_MS),
      );
      if (!response.ok) throw new Error(`answered ${response.status}`);
      const { version } = (await response.json()) as { version?: unknown };
      if (typeof version === "string") this.#serverVersion = version;
    } catch (error) {
      mainLog.warn(`Eidolon: couldn't read the server's version: ${String(error)}`);
    }
  }
}
