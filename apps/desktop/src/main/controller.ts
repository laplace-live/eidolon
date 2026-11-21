// The backend controller: one attempt at a time to reach a server on the data home, by attaching
// to one that proves itself or by spawning the app's own, and what follows: restarts, the attach
// grace period, the wait after a refused spawn, failures and the stop. Electron-free:
// the wiring gives it the launch, the environment and the data home, and follows its state.
import { type SpawnOptions, spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  type BearerToken,
  hintFrom,
  isAlive,
  isPort,
  originOf,
  probe,
  proveSocket,
  readServerInfo,
  readToken,
  type ServerInfo,
} from "./attach.ts";
import { ALREADY_RUNNING_LINE, filterLines } from "./log-filter.ts";

/** jsRuntime().args inside Electron, which main can't import: a test holds the two equal. */
export const BACKEND_RUNTIME_ARGS: readonly string[] = ["--disable-sigusr1", "--use-system-ca"];
export const DEFAULT_PORT = 7860;
/** EX_TEMPFAIL: the server stopped so that a new one can start on its port. */
export const RESTART_EXIT_CODE = 75;

const LISTEN_TIMEOUT_MS = 60_000;
/** How long a refused spawn or an attached grace period probes: the web app's restart wait. */
const RECOVER_MS = 60_000;
const PROBE_EVERY_MS = 500;
const STOP_GRACE_MS = 10_000;
const STOP_KILL_MS = 5_000;
/** A session end's stop with no session end after it: another app vetoed the shutdown. */
const VETOED_SHUTDOWN_MS = 10_000;
const SESSION_END_WAIT_MS = 4000;
const SESSION_END_POLL_MS = 50;
/** How long an exit waits for the last of the backend's output, which can trail it. */
const DRAIN_MS = 500;
const STDERR_LINES = 30;

export interface BackendFailure {
  /**
   * `exited`: the backend exited other than to restart; `no-listening`: it didn't listen within
   * 60 s; `held`: another Eidolon holds the data home and never proved itself; `token`: no
   * local-token to send once it listened; `unanswered`: it stopped answering for 60 s; `error`:
   * it couldn't be started.
   */
  readonly reason: "exited" | "no-listening" | "held" | "token" | "unanswered" | "error";
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  /** For `held`: the other Eidolon, as its lock or its refusal named it. */
  readonly holder?: Holder;
  readonly message?: string;
  /** The backend's last lines on stderr, since it listened if it did, for the failure page. */
  readonly stderr: readonly string[];
}

export interface Holder {
  readonly pid: number | null;
  readonly port: number | null;
}

/**
 * `ready`: forward to `origin` with `token`, our own server's or one attached to. `holding`: the
 * server may have changed, so requests wait without the Bearer. `starting` and `failed` have no
 * server to forward to.
 */
export type BackendState =
  | { readonly phase: "starting" }
  | {
      readonly phase: "ready";
      readonly origin: string;
      readonly token: BearerToken;
      readonly owned: boolean;
      /** The server's process: our child, or the one an attached server's lock names. */
      readonly pid: number | null;
    }
  | { readonly phase: "holding"; readonly owned: boolean }
  | { readonly phase: "failed"; readonly failure: BackendFailure }
  | { readonly phase: "stopped" };

export type ReadyState = Extract<BackendState, { phase: "ready" }>;

/** What starts the backend. */
export interface BackendLaunch {
  /** The app binary, which runs it as Node. */
  readonly command: string;
  readonly entry: string;
  /** EIDOLON_APP_ROOT, the staged payload; null in dev, where files resolve from the checkout. */
  readonly appRoot: string | null;
}

/** Where the app runs from, as Electron gives it. */
export interface AppPaths {
  readonly packaged: boolean;
  readonly execPath: string;
  readonly resourcesPath: string;
  /** app.getAppPath(): apps/desktop unpackaged. */
  readonly appPath: string;
}

/** The staged payload's server when packaged; in dev, the checkout's, from source. */
export function backendLaunch(app: AppPaths): BackendLaunch {
  if (!app.packaged) {
    const entry = resolve(app.appPath, "..", "bot", "src", "local", "server.ts");
    return { command: app.execPath, entry, appRoot: null };
  }
  const payload = join(app.resourcesPath, "eidolon");
  return { command: app.execPath, entry: join(payload, "dist", "server.js"), appRoot: payload };
}

/**
 * `env` with the backend's own variables, names matched without case on Windows. EIDOLON_HOME is
 * the controller's home, so the backend and main never read two homes.
 */
export function backendEnv(
  env: NodeJS.ProcessEnv,
  vars: {
    readonly home: string;
    readonly appRoot: string | null;
    readonly platform: NodeJS.Platform;
  },
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  const set = (name: string, value: string | null): void => {
    for (const key of Object.keys(result)) {
      if (key === name || (vars.platform === "win32" && key.toUpperCase() === name)) {
        delete result[key];
      }
    }
    if (value !== null) result[name] = value;
  };
  set("EIDOLON_HOME", vars.home);
  set("EIDOLON_APP_ROOT", vars.appRoot);
  set("EIDOLON_NO_DOTENV", "1");
  set("ELECTRON_RUN_AS_NODE", "1");
  return result;
}

/** The part of a ChildProcess the controller drives. */
export interface BackendChild {
  readonly pid?: number | undefined;
  readonly connected: boolean;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  disconnect(): void;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Everything the controller does outside itself; tests replace any of it. */
export interface ControllerIo {
  spawn(command: string, args: readonly string[], options: SpawnOptions): BackendChild;
  /** Whether a test bind of 127.0.0.1:`port` fails as a taken port does. */
  portTaken(port: number): Promise<boolean>;
  readServerInfo(home: string): ServerInfo | null;
  readToken(home: string): BearerToken | null;
  isAlive(pid: number): boolean;
  probe(origin: string, token: BearerToken): Promise<boolean>;
  proveSocket(socket: Socket, origin: string, token: BearerToken): Promise<boolean>;
  /** Blocks the thread; only the session end, which has no event loop left, may. */
  sleepSync(ms: number): void;
}

/** EADDRINUSE, or EACCES: a Hyper-V or WinNAT excluded range on Windows. */
export function isTakenPortError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EADDRINUSE" || code === "EACCES";
}

function portTaken(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => done(isTakenPortError(error)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => done(false));
    });
  });
}

export const processIo: ControllerIo = {
  spawn: (command, args, options) => spawn(command, [...args], options),
  portTaken,
  readServerInfo,
  readToken,
  isAlive,
  probe: (origin, token) => probe(origin, token),
  proveSocket: (socket, origin, token) => proveSocket(socket, origin, token),
  sleepSync: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

export interface MainLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ControllerOptions {
  /** The data home: where the hint and local-token are read, and the backend's EIDOLON_HOME. */
  readonly home: string;
  readonly launch: BackendLaunch;
  /** The backend's environment, before the controller's variables; called before each spawn. */
  readonly environment: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  /** Each line the backend prints, but the two with a link code. */
  readonly backendLog?: (stream: "stdout" | "stderr", line: string) => void;
  readonly log?: MainLog;
  /** The port a first spawn asks for. */
  readonly port?: number;
  readonly platform?: NodeJS.Platform;
  /** The backend's working folder: the home folder, so it holds no handle on the app's own. */
  readonly cwd?: string;
  readonly io?: Partial<ControllerIo>;
}

/** One spawned backend process, from its spawn to its exit. */
interface Spawned {
  readonly child: BackendChild;
  /** The port it was asked for. */
  readonly port: number;
  /** The port it reported listening on. */
  bound: number | null;
  /** It printed the second start's line: this home's server serves the port it asked for. */
  alreadyRunning: boolean;
  /** It refused to start, naming the server that holds the data home. */
  refusal: Holder | null;
  /** It failed to bind its port: another program holds it, or Windows excludes it. */
  portTaken: boolean;
  readonly stderr: string[];
  exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null;
  /** Resolves once the process is gone. */
  readonly gone: Promise<void>;
  handled: boolean;
  /** Its exit is expected: our stop, or a failure's cleanup. */
  stopping: boolean;
  /** A session end stopped it. */
  sessionEnd: boolean;
  listenTimer: ReturnType<typeof setTimeout> | null;
}

interface Found {
  readonly origin: string;
  readonly port: number;
  readonly pid: number;
  readonly token: BearerToken;
}

function isListening(message: unknown): message is { kind: "listening"; port: number } {
  const value = message as { kind?: unknown; port?: unknown } | null;
  return value?.kind === "listening" && isPort(value.port);
}

/** `(pid 4242, port 7861)`'s fields, as boot.ts names the holder. */
function holderFrom(named: string): Holder {
  const pid = /\bpid (\d+)/.exec(named)?.[1];
  const port = /\bport (\d+)/.exec(named)?.[1];
  return {
    pid: pid === undefined ? null : Number(pid),
    port: port === undefined ? null : Number(port),
  };
}

const REFUSED_LINE = /already running on this data home(?: \(([^)]*)\))?/;
const EACCES_LINE = /\blisten EACCES\b/;

/** Whether `promise` settles within `ms`. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms);
    void promise.then(
      () => {
        clearTimeout(timer);
        done(true);
      },
      () => {
        clearTimeout(timer);
        done(true);
      },
    );
  });
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function sameState(a: BackendState, b: BackendState): boolean {
  if (a.phase !== b.phase) return false;
  if (a.phase === "starting" || a.phase === "stopped") return true;
  return a.phase === "holding" && b.phase === "holding" && a.owned === b.owned;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BackendController {
  readonly #home: string;
  readonly #launch: BackendLaunch;
  readonly #environment: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  readonly #backendLog: (stream: "stdout" | "stderr", line: string) => void;
  readonly #log: MainLog;
  readonly #preferredPort: number;
  readonly #platform: NodeJS.Platform;
  readonly #cwd: string;
  readonly #io: ControllerIo;
  readonly #listeners = new Set<(state: BackendState) => void>();
  #state: BackendState = { phase: "starting" };
  /** Bumped by every transition: a flow that finds it moved on stops. */
  #epoch = 0;
  #started = false;
  #stopped = false;
  #stopping: Promise<void> | null = null;
  #child: Spawned | null = null;
  /** Our backends sent their stop trigger and not yet exited: a session end waits for each. */
  readonly #exiting = new Set<Spawned>();
  /** A failed attempt's child, being stopped: the next attempt waits for it. */
  #cleanup: Promise<void> = Promise.resolve();
  #attached: { readonly origin: string; readonly port: number } | null = null;
  #vetoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ControllerOptions) {
    this.#home = options.home;
    this.#launch = options.launch;
    this.#environment = options.environment;
    this.#backendLog = options.backendLog ?? (() => {});
    this.#log = options.log ?? console;
    this.#preferredPort = options.port ?? DEFAULT_PORT;
    this.#platform = options.platform ?? process.platform;
    this.#cwd = options.cwd ?? homedir();
    this.#io = { ...processIo, ...options.io };
  }

  get state(): BackendState {
    return this.#state;
  }

  /** Calls `listener` with every new state; returns what stops it. */
  subscribe(listener: (state: BackendState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The first attempt, or Try Again after a failure; one runs at a time. */
  start(): void {
    if (this.#stopped || (this.#started && this.#state.phase !== "failed")) return;
    this.#started = true;
    const epoch = this.#begin({ phase: "starting" });
    this.#run(epoch, async () => {
      await this.#cleanup;
      if (!this.#current(epoch)) return;
      const found = await this.#proveHint();
      if (!this.#current(epoch)) return;
      if (found !== null) this.#attachTo(found);
      else await this.#spawn(epoch, this.#preferredPort);
    });
  }

  /**
   * Stops our own backend: the IPC channel's close, its stop trigger, then kill() after 10 s and,
   * off Windows, SIGKILL after 5 s more. Never a tree, and never an attached server. Nothing
   * starts after it.
   */
  stop(): Promise<void> {
    if (this.#stopping !== null) return this.#stopping;
    this.#stopped = true;
    this.#epoch++;
    if (this.#vetoTimer !== null) clearTimeout(this.#vetoTimer);
    // No Bearer from here on: the backend closes its listener long before it exits.
    const state = this.#state;
    if (state.phase === "ready") this.#set({ phase: "holding", owned: state.owned });
    const spawned = this.#child;
    this.#child = null;
    this.#attached = null;
    this.#stopping = (async () => {
      if (spawned !== null) {
        spawned.stopping = true;
        await this.#stopChild(spawned);
      }
      await this.#cleanup;
      this.#set({ phase: "stopped" });
    })();
    return this.#stopping;
  }

  /** The forwarder's report of a connection to `origin` refused, or that didn't prove itself. */
  refused(origin: string): void {
    const state = this.#state;
    if (state.phase !== "ready" || state.origin !== origin) return;
    if (state.owned) this.#holdOwned(state);
    else this.#grace(`a connection to ${origin} was refused or didn't prove itself`);
  }

  /** The forwarder's report of a POST /api/local/restart that `origin` answered with a 2xx. */
  restarted(origin: string): void {
    const state = this.#state;
    if (state.phase !== "ready" || state.origin !== origin) return;
    if (!state.owned) {
      this.#grace(`${origin} restarts`);
      return;
    }
    this.#log.info("Eidolon: the backend restarts; requests wait for it to listen again");
    this.#begin({ phase: "holding", owned: true });
  }

  /** The forwarder's report of a connection to `origin` closing: an attached server may change. */
  disconnected(origin: string): void {
    const state = this.#state;
    if (state.phase === "ready" && !state.owned && state.origin === origin) this.#grace(null);
  }

  /**
   * Whether `socket`, the forwarder's new connection to `origin`, reaches the server ready there,
   * proved over the socket itself. A server restarted elsewhere while no connection was open gives
   * no other sign, and whatever holds its address next gets the new connection. An attached
   * server's hint must still name `origin`, so that a relay there can't pass on the probe to a
   * server that moved.
   */
  async proveConnection(socket: Socket, origin: string): Promise<boolean> {
    const state = this.#state;
    if (state.phase !== "ready" || state.origin !== origin) return false;
    if (!state.owned) {
      const hint = hintFrom(this.#io.readServerInfo(this.#home));
      if (hint === null || originOf(hint) !== origin || !this.#io.isAlive(hint.pid)) return false;
    }
    return this.#io.proveSocket(socket, origin, state.token);
  }

  /**
   * Windows' query-session-end: the stop trigger alone. Node closes the IPC channel only on the
   * next tick after disconnect(), so whatever blocks after this must not run in the same handler.
   */
  sessionEnding(): void {
    const spawned = this.#child;
    if (this.#stopped || spawned === null || spawned.exit !== null || spawned.stopping) return;
    spawned.sessionEnd = true;
    this.#exiting.add(spawned);
    if (spawned.child.connected) spawned.child.disconnect();
    this.#begin({ phase: "holding", owned: true });
  }

  /**
   * Windows' session-end, after which Electron ends this process and our backend with it: waits,
   * blocking, up to about 4 s for every stop under way, sessionEnding's, a quit's or a failure's.
   * No event can run here, so an exit shows only as its pid going away.
   */
  sessionEnded(): void {
    const pids = [...this.#exiting].flatMap(({ child }) => child.pid ?? []);
    const deadline = Date.now() + SESSION_END_WAIT_MS;
    while (pids.some((pid) => this.#io.isAlive(pid)) && Date.now() < deadline) {
      this.#io.sleepSync(SESSION_END_POLL_MS);
    }
  }

  #set(state: BackendState): void {
    if (sameState(this.#state, state)) return;
    this.#state = state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch (error) {
        this.#log.error(`Eidolon: a backend state listener failed: ${errorText(error)}`);
      }
    }
  }

  /** Moves to `state`, superseding whatever flow ran; returns the new flow's epoch. */
  #begin(state: BackendState): number {
    this.#epoch++;
    this.#set(state);
    return this.#epoch;
  }

  #current(epoch: number): boolean {
    return epoch === this.#epoch && !this.#stopped;
  }

  #run(epoch: number, flow: () => Promise<void>): void {
    flow().catch((error: unknown) => {
      this.#log.error(`Eidolon: the backend controller failed: ${errorText(error)}`);
      if (this.#current(epoch)) {
        this.#fail({ reason: "error", message: errorText(error), stderr: [] });
      }
    });
  }

  #fail(failure: BackendFailure): void {
    this.#log.error(`Eidolon: the backend failed (${failure.reason})`);
    this.#begin({ phase: "failed", failure });
  }

  /** The server the hint names, if it is alive and proves it holds local-token. */
  async #proveHint(): Promise<Found | null> {
    const hint = hintFrom(this.#io.readServerInfo(this.#home));
    if (hint === null || !this.#io.isAlive(hint.pid)) return null;
    const token = this.#io.readToken(this.#home);
    if (token === null) return null;
    const origin = originOf(hint);
    return (await this.#io.probe(origin, token))
      ? { origin, port: hint.port, pid: hint.pid, token }
      : null;
  }

  #attachTo(found: Found): void {
    if (this.#attached?.origin !== found.origin) {
      this.#log.info(`Eidolon: using the server already on this data home, ${found.origin}`);
    }
    this.#attached = { origin: found.origin, port: found.port };
    this.#begin({
      phase: "ready",
      origin: found.origin,
      token: found.token,
      owned: false,
      pid: found.pid,
    });
  }

  /** Probes every 500 ms for up to 60 s; null when nothing proved itself, or the flow moved on. */
  async #recover<T>(epoch: number, prove: () => Promise<T | null>): Promise<T | null> {
    // The timers' clock: the wall clock moves on while a Mac sleeps, and would end the wait at the
    // first probe after it wakes.
    const deadline = performance.now() + RECOVER_MS;
    for (;;) {
      const found = await prove();
      if (!this.#current(epoch) || found !== null) return found;
      if (performance.now() + PROBE_EVERY_MS > deadline) return null;
      await sleep(PROBE_EVERY_MS);
      if (!this.#current(epoch)) return null;
    }
  }

  /**
   * An attached server may have changed: no Bearer until it, or whatever the hint names next,
   * proves itself. Only after 60 s with none does our own start, on its port.
   */
  #grace(why: string | null): void {
    const attached = this.#attached;
    if (attached === null) return;
    if (why !== null) this.#log.info(`Eidolon: ${why}; requests wait for a server to prove itself`);
    const epoch = this.#begin({ phase: "holding", owned: false });
    this.#run(epoch, async () => {
      const found = await this.#recover(epoch, () => this.#proveHint());
      if (!this.#current(epoch)) return;
      if (found !== null) {
        this.#attachTo(found);
        return;
      }
      this.#attached = null;
      this.#log.warn(
        `Eidolon: no server answered on this data home for 60 s; starting one on port ${attached.port}`,
      );
      this.#respawn(attached.port, { phase: "starting" });
    });
  }

  /**
   * A connection to our own server was refused or didn't prove itself: it may be closing. A proof
   * or its exit ends the hold.
   */
  #holdOwned(ready: ReadyState): void {
    const spawned = this.#child;
    if (spawned === null) return;
    const { origin, token } = ready;
    this.#log.warn(
      `Eidolon: a connection to ${origin} was refused or didn't prove itself; requests wait for it`,
    );
    const epoch = this.#begin({ phase: "holding", owned: true });
    this.#run(epoch, async () => {
      const answered = await this.#recover(epoch, async () =>
        (await this.#io.probe(origin, token)) ? true : null,
      );
      if (!this.#current(epoch)) return;
      if (answered) this.#begin(ready);
      else this.#failAndStop(spawned, { reason: "unanswered", stderr: [...spawned.stderr] });
    });
  }

  #respawn(port: number, state: BackendState): void {
    const epoch = this.#begin(state);
    this.#run(epoch, () => this.#spawn(epoch, port));
  }

  async #spawn(epoch: number, port: number): Promise<void> {
    const env = await this.#environment();
    if (!this.#current(epoch)) return;
    let asked = port;
    if (asked !== 0 && (await this.#io.portTaken(asked))) {
      this.#log.info(`Eidolon: port ${asked} is taken; the backend takes a free one`);
      asked = 0;
    }
    if (!this.#current(epoch)) return;
    const args = [
      ...BACKEND_RUNTIME_ARGS,
      this.#launch.entry,
      "--host",
      "127.0.0.1",
      "--port",
      String(asked),
      "--no-open",
    ];
    const child = this.#io.spawn(this.#launch.command, args, {
      cwd: this.#cwd,
      env: backendEnv(env, {
        home: this.#home,
        appRoot: this.#launch.appRoot,
        platform: this.#platform,
      }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    this.#log.info(`Eidolon: started the backend (pid ${child.pid ?? "none"}) on port ${asked}`);
    this.#watch(child, asked);
  }

  #watch(child: BackendChild, port: number): void {
    let gone = (): void => {};
    const spawned: Spawned = {
      child,
      port,
      bound: null,
      alreadyRunning: false,
      refusal: null,
      portTaken: false,
      stderr: [],
      exit: null,
      gone: new Promise((done) => {
        gone = done;
      }),
      handled: false,
      stopping: false,
      sessionEnd: false,
      listenTimer: null,
    };
    this.#child = spawned;
    const drained = Promise.all([
      filterLines(
        child.stdout,
        (line) => {
          if (line.includes(ALREADY_RUNNING_LINE)) spawned.alreadyRunning = true;
        },
        (line) => this.#backendLog("stdout", line),
      ),
      filterLines(
        child.stderr,
        (line) => this.#stderrLine(spawned, line),
        (line) => this.#backendLog("stderr", line),
      ),
    ]);
    child.on("message", (message) => this.#message(spawned, message));
    child.on("exit", (code, signal) => {
      spawned.exit = { code, signal };
      this.#exiting.delete(spawned);
      gone();
      void within(drained, DRAIN_MS).then(() => this.#exited(spawned));
    });
    child.on("error", (error) => {
      this.#log.error(`Eidolon: the backend process: ${error.message}`);
      // No pid: it never started, and no exit follows.
      if (child.pid !== undefined || spawned.exit !== null) return;
      spawned.exit = { code: null, signal: null };
      this.#exiting.delete(spawned);
      gone();
      this.#exited(spawned, error.message);
    });
    spawned.listenTimer = setTimeout(() => this.#noListening(spawned), LISTEN_TIMEOUT_MS);
  }

  #stderrLine(spawned: Spawned, line: string): void {
    spawned.stderr.push(line);
    if (spawned.stderr.length > STDERR_LINES) spawned.stderr.shift();
    const refused = REFUSED_LINE.exec(line);
    if (refused !== null) spawned.refusal = holderFrom(refused[1] ?? "");
    if (
      (spawned.port !== 0 && line.includes(`port ${spawned.port} is taken by another program`)) ||
      EACCES_LINE.test(line)
    ) {
      spawned.portTaken = true;
    }
  }

  #message(spawned: Spawned, message: unknown): void {
    if (!isListening(message)) {
      this.#log.warn(
        'Eidolon: ignored a message from the backend that isn\'t {kind: "listening", port}',
      );
      return;
    }
    if (
      spawned !== this.#child ||
      spawned.bound !== null ||
      spawned.stopping ||
      spawned.sessionEnd
    ) {
      this.#log.warn(`Eidolon: ignored the backend's listening on port ${message.port}`);
      return;
    }
    if (spawned.listenTimer !== null) clearTimeout(spawned.listenTimer);
    spawned.bound = message.port;
    // After every listening: a first start writes local-token, and deleting it rotates it.
    const token = this.#io.readToken(this.#home);
    if (token === null) {
      this.#failAndStop(spawned, { reason: "token", stderr: [...spawned.stderr] });
      return;
    }
    const origin = `http://127.0.0.1:${message.port}`;
    this.#log.info(`Eidolon: the backend listens on ${origin}`);
    // What it wrote while booting belongs to a start that worked, such as a fresh home's warnings
    // that name commands to build its indexes: a failure from here on shows what came after.
    spawned.stderr.length = 0;
    this.#begin({ phase: "ready", origin, token, owned: true, pid: spawned.child.pid ?? null });
  }

  #noListening(spawned: Spawned): void {
    spawned.listenTimer = null;
    if (spawned !== this.#child || spawned.bound !== null || spawned.exit !== null) return;
    this.#failAndStop(spawned, { reason: "no-listening", stderr: [...spawned.stderr] });
  }

  /** Fails at once, while the child stops in the background; Try Again waits for it. */
  #failAndStop(spawned: Spawned, failure: BackendFailure): void {
    spawned.stopping = true;
    if (this.#child === spawned) this.#child = null;
    this.#cleanup = this.#stopChild(spawned);
    this.#fail(failure);
  }

  #exited(spawned: Spawned, spawnError?: string): void {
    if (spawned.handled) return;
    spawned.handled = true;
    if (spawned.listenTimer !== null) clearTimeout(spawned.listenTimer);
    const { code, signal } = spawned.exit ?? { code: null, signal: null };
    this.#log.info(
      `Eidolon: the backend (pid ${spawned.child.pid ?? "none"}) exited (${code ?? signal ?? spawnError})`,
    );
    if (spawned !== this.#child) return;
    this.#child = null;
    if (spawned.stopping || this.#stopped) return;
    if (spawned.sessionEnd) {
      this.#afterSessionEnd(spawned);
      return;
    }
    const stderr = [...spawned.stderr];
    if (spawnError !== undefined) {
      this.#fail({ reason: "error", message: spawnError, stderr });
      return;
    }
    if (spawned.bound === null) {
      if (code === 0 && spawned.alreadyRunning) {
        const pid = this.#io.readServerInfo(this.#home)?.pid ?? null;
        this.#refused({ pid, port: spawned.port }, stderr);
        return;
      }
      if (code === 2 && spawned.refusal !== null) {
        this.#refused(spawned.refusal, stderr);
        return;
      }
      if (code === 1 && spawned.port !== 0 && spawned.portTaken) {
        this.#log.info(
          `Eidolon: port ${spawned.port} turned out taken; the backend takes a free one`,
        );
        this.#respawn(0, { phase: "starting" });
        return;
      }
    } else if (code === RESTART_EXIT_CODE) {
      this.#respawn(spawned.bound, { phase: "holding", owned: true });
      return;
    }
    this.#fail({ reason: "exited", code, signal, stderr });
  }

  /**
   * Another Eidolon holds the data home. Main never spawns again on its own: a holder that keeps
   * the lock without answering would boot a whole backend each round, and a respawn could take the
   * lock from a terminal supervisor's next child. It attaches to the first server that proves
   * itself.
   */
  #refused(holder: Holder, stderr: readonly string[]): void {
    this.#log.warn(
      `Eidolon: another Eidolon holds this data home (pid ${holder.pid ?? "unknown"}, port ${holder.port ?? "unknown"})`,
    );
    const epoch = this.#begin({ phase: "starting" });
    this.#run(epoch, async () => {
      const found = await this.#recover(epoch, () => this.#proveHint());
      if (!this.#current(epoch)) return;
      if (found !== null) {
        this.#attachTo(found);
        return;
      }
      const info = this.#io.readServerInfo(this.#home);
      this.#fail({
        reason: "held",
        holder: { pid: info?.pid ?? holder.pid, port: info?.port ?? holder.port },
        stderr,
      });
    });
  }

  /** Our backend stopped for a session end that never came: another app vetoed the shutdown. */
  #afterSessionEnd(spawned: Spawned): void {
    const port = spawned.bound ?? spawned.port;
    const epoch = this.#begin({ phase: "holding", owned: true });
    this.#vetoTimer = setTimeout(() => {
      this.#vetoTimer = null;
      if (!this.#current(epoch)) return;
      this.#log.info("Eidolon: the session didn't end; starting the backend again");
      this.#run(epoch, () => this.#spawn(epoch, port));
    }, VETOED_SHUTDOWN_MS);
  }

  async #stopChild(spawned: Spawned): Promise<void> {
    const { child } = spawned;
    if (spawned.listenTimer !== null) clearTimeout(spawned.listenTimer);
    if (spawned.exit !== null) return;
    this.#exiting.add(spawned);
    if (child.connected) child.disconnect();
    if (await within(spawned.gone, STOP_GRACE_MS)) return;
    this.#log.warn(`Eidolon: the backend (pid ${child.pid}) didn't stop within 10 s; killing it`);
    child.kill();
    if (await within(spawned.gone, STOP_KILL_MS)) return;
    if (this.#platform !== "win32") {
      child.kill("SIGKILL");
      if (await within(spawned.gone, STOP_KILL_MS)) return;
    }
    this.#log.error(`Eidolon: the backend (pid ${child.pid}) didn't exit; giving up on it`);
  }
}
