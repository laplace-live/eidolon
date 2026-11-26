// The backend as main follows it: the environment, the data home, the controller that attaches to
// its server or spawns the app's own (the packaged payload, or unpackaged the checkout's server on
// the dev Electron's node mode), and the forwarder the app host goes through. The window follows
// its state, and learns each server's version before it shows the app. Electron-free: index.ts
// hands it Electron's values and the logs.
import { join } from "node:path";
import { dataHome } from "./attach.ts";
import {
  type AppPaths,
  BackendController,
  type BackendState,
  backendLaunch,
  type MainLog,
  type ReadyState,
  sameServer,
} from "./controller.ts";
import { startupEnvironment } from "./environment.ts";
import {
  createForwarder,
  type Forwarder,
  type SchemeRequest,
  unreachable,
  type WaitingPage,
} from "./forwarder.ts";
import { checkQuit } from "./quit-check.ts";
import type { Stopping } from "./strings.ts";

/** The license texts the Licenses item opens, which stage-backend writes into the payload. */
export function licensesFile(app: AppPaths): string {
  const payload = app.packaged
    ? join(app.resourcesPath, "eidolon")
    : join(app.appPath, ".stage", `${process.platform}-${process.arch}`, "eidolon");
  return join(payload, "THIRD_PARTY_LICENSES.txt");
}

const VERSION_TIMEOUT_MS = 2_000;

export interface BackendOptions {
  readonly app: AppPaths;
  /** The environment the app was launched with. */
  readonly env: NodeJS.ProcessEnv;
  /** main.log. */
  readonly log: MainLog;
  /** backend.log: each line the backend prints, but the two with a link code. */
  readonly backendLog: (line: string) => void;
  /** Dev: apps/web's Vite server, for every path but the backend's own. */
  readonly devServer?: string;
  readonly waitingPage: WaitingPage;
  /** The port a first spawn asks for. */
  readonly port?: number;
}

export class Backend {
  readonly #options: BackendOptions;
  /**
   * Ends the environment's read still running at a quit: a login shell's, whose process group
   * outlives main, or PowerShell's.
   */
  readonly #abort = new AbortController();
  readonly #listeners = new Set<(state: BackendState) => void>();
  #controller: BackendController | null = null;
  #forwarder: Forwarder | null = null;
  #home: string | null = null;
  /** The version a server reported, and which server it was. */
  #version: { readonly server: ReadyState; readonly version: string } | null = null;
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

  /** The version of the server the window follows, from its status; empty while unknown. */
  get serverVersion(): string {
    return this.#version?.version ?? "";
  }

  /**
   * Calls `listener` with each state for the window to follow: a ready one only once its server's
   * version is known, so the page's bridge has it, and never one the controller has moved past.
   */
  subscribe(listener: (state: BackendState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Reads the environment once (the login shell on macOS, the registry on Windows), resolves the
   * data home from it, and starts the controller, whose first spawn takes that same read.
   */
  async start(): Promise<void> {
    const { app, env, log } = this.#options;
    const startup = await startupEnvironment(env, { log, signal: this.#abort.signal });
    if (this.#stopped) return;
    const home = dataHome(startup.env);
    this.#home = home;
    log.info(`Eidolon: the data home is ${home}`);
    const controller = new BackendController({
      home,
      launch: backendLaunch(app),
      environment: startup.forSpawn,
      backendLog: (_stream, line) => this.#options.backendLog(line),
      log,
      ...(this.#options.port === undefined ? {} : { port: this.#options.port }),
    });
    this.#forwarder = createForwarder({
      backend: controller,
      waitingPage: this.#options.waitingPage,
      devServer: this.#options.devServer,
      log,
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

  /**
   * A GET of main's own at `path` to the server ready now, ours or attached, with the Bearer;
   * rejects while none is.
   */
  get(
    path: string,
    signal: AbortSignal,
    options?: { readonly local?: boolean },
  ): Promise<Response> {
    return (
      this.#forwarder?.get(path, signal, options) ?? Promise.reject(new Error("no server is ready"))
    );
  }

  /** What a quit would stop, from our own ready backend; null while attached or not ready. */
  quitCheck(): Promise<Stopping> | null {
    const forwarder = this.#forwarder;
    const state = this.state;
    if (forwarder === null || state.phase !== "ready" || !state.owned) return null;
    return checkQuit((path, { signal }) => forwarder.get(path, signal, { local: true }));
  }

  /** The stop of our own backend only, never an attached server. */
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
    if (state.phase === "ready" && !this.#knows(state)) {
      const version = await this.#readVersion();
      // It moved on meanwhile, and that state has been told already.
      if (controller.state !== state) return;
      // One that can't be read is unknown, never the server before's.
      this.#version = version === null ? null : { server: state, version };
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch (error) {
        this.#options.log.error(`Eidolon: following the backend failed: ${String(error)}`);
      }
    }
  }

  /**
   * Whether `ready`'s server is the one whose version is known. An attached server proved again
   * after an idle close is the same; a restart, ours or one from outside, is a new process.
   */
  #knows(ready: ReadyState): boolean {
    return this.#version !== null && sameServer(this.#version.server, ready);
  }

  /** The ready server's status's version: it may be a terminal's of another version. */
  async #readVersion(): Promise<string | null> {
    const forwarder = this.#forwarder;
    if (forwarder === null) return null;
    try {
      const response = await forwarder.get(
        "/api/local/status",
        AbortSignal.timeout(VERSION_TIMEOUT_MS),
        { local: true },
      );
      if (!response.ok) throw new Error(`answered ${response.status}`);
      const { version } = (await response.json()) as { version?: unknown };
      if (typeof version !== "string") throw new Error("its status has no version");
      return version;
    } catch (error) {
      this.#options.log.warn(`Eidolon: couldn't read the server's version: ${String(error)}`);
      return null;
    }
  }
}
