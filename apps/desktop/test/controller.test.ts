import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { jsRuntime } from "@eidolon/config";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { asElectron } from "../../../packages/config/test/electron.ts";
import { BearerToken, type ServerInfo } from "../src/main/attach.ts";
import {
  BACKEND_RUNTIME_ARGS,
  BackendController,
  type BackendState,
  backendEnv,
  backendLaunch,
  type ControllerIo,
  isTakenPortError,
  processIo,
  type ReadyState,
} from "../src/main/controller.ts";

const HOME = "/Users/me/.laplace/eidolon";
const LAUNCH = {
  command: "/Applications/Eidolon.app/Contents/MacOS/Eidolon",
  entry: "/Applications/Eidolon.app/Contents/Resources/eidolon/dist/server.js",
  appRoot: "/Applications/Eidolon.app/Contents/Resources/eidolon",
};
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);
const LINK = `#1793000000.${"c".repeat(43)}`;

let nextPid = 70_000;

/** A backend process: it prints, listens and exits when the test says. */
class FakeChild extends EventEmitter {
  readonly pid: number | undefined;
  connected = true;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: (NodeJS.Signals | undefined)[] = [];
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
  readonly #trace: string[];

  constructor(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
    trace: string[],
    started = true,
  ) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.#trace = trace;
    this.pid = started ? nextPid++ : undefined;
  }

  get port(): string | undefined {
    return this.args[this.args.indexOf("--port") + 1];
  }

  disconnect(): void {
    this.connected = false;
    this.#trace.push("disconnect");
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    this.#trace.push(signal === undefined ? "kill" : `kill ${signal}`);
    return true;
  }

  listen(port: number): void {
    this.emit("message", { kind: "listening", port });
  }

  print(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  complain(line: string): void {
    this.stderr.write(`${line}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.connected = false;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
  }
}

interface Rig {
  readonly controller: BackendController;
  readonly children: FakeChild[];
  readonly states: BackendState[];
  readonly logs: string[];
  readonly backendLines: string[];
  readonly trace: string[];
  readonly probes: string[];
  /** Each connection proof asked for: its origin and the secret it checked. */
  readonly connectionProofs: [string, string][];
  readonly taken: Set<number>;
  info: ServerInfo | null;
  token: string | null;
  alive: (pid: number) => boolean;
  proves: (origin: string, secret: string) => boolean;
  last(): FakeChild;
}

function rig(
  options: {
    platform?: NodeJS.Platform;
    port?: number;
    io?: Partial<ControllerIo>;
    environment?: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  } = {},
): Rig {
  const children: FakeChild[] = [];
  const trace: string[] = [];
  const logs: string[] = [];
  const r: { -readonly [K in keyof Rig]: Rig[K] } = {
    controller: undefined as unknown as BackendController,
    children,
    states: [],
    logs,
    backendLines: [],
    trace,
    probes: [],
    connectionProofs: [],
    taken: new Set(),
    info: null,
    token: TOKEN_A,
    alive: () => true,
    proves: () => false,
    last: () => {
      const child = children.at(-1);
      if (child === undefined) throw new Error("nothing was spawned");
      return child;
    },
  };
  const io: Partial<ControllerIo> = {
    spawn: (command, args, spawnOptions) => {
      const child = new FakeChild(command, args, spawnOptions, trace);
      children.push(child);
      return child;
    },
    portTaken: async (port) => r.taken.has(port),
    readServerInfo: () => r.info,
    readToken: () => (r.token === null ? null : new BearerToken(r.token)),
    isAlive: (pid) => {
      trace.push(`alive? ${pid}`);
      return r.alive(pid);
    },
    probe: async (origin, token) => {
      r.probes.push(origin);
      return r.proves(origin, token.secret);
    },
    proveSocket: async (_socket, origin, token) => {
      r.connectionProofs.push([origin, token.secret]);
      return r.proves(origin, token.secret);
    },
    sleepSync: (ms) => {
      trace.push(`sleep ${ms}`);
      vi.setSystemTime(Date.now() + ms);
    },
    ...options.io,
  };
  r.controller = new BackendController({
    home: HOME,
    launch: LAUNCH,
    environment: options.environment ?? (() => ({ PATH: "/usr/bin:/bin", LANG: "zh_CN.UTF-8" })),
    backendLog: (stream, line) => r.backendLines.push(`${stream}: ${line}`),
    log: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
    ...(options.port === undefined ? {} : { port: options.port }),
    platform: options.platform ?? "darwin",
    cwd: "/Users/me",
    io,
  });
  r.controller.subscribe((state) => r.states.push(state));
  return r;
}

/** Lets every pending promise, stream event and zero-delay timer run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) await vi.advanceTimersByTimeAsync(0);
}

function ready(r: Rig): ReadyState {
  const { state } = r.controller;
  if (state.phase !== "ready") throw new Error(`not ready: ${state.phase}`);
  return state;
}

/** Started, with its first backend listening on `port`. */
async function running(r: Rig, port = 7860): Promise<FakeChild> {
  r.controller.start();
  await settle();
  const child = r.last();
  child.listen(port);
  return child;
}

/** Started, attached to the server the hint names. */
async function attached(r: Rig, host = "127.0.0.1", port = 7861): Promise<string> {
  const origin = `http://${host}:${port}`;
  r.info = { pid: 4242, port, host };
  r.proves = (at) => at === origin;
  r.controller.start();
  await settle();
  expect(r.controller.state).toMatchObject({ phase: "ready", origin, owned: false, pid: 4242 });
  return origin;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the spawn", () => {
  test("is the app binary on the payload's server, as Node, on 127.0.0.1:7860 with no browser", async () => {
    const r = rig();
    r.controller.start();
    await settle();
    const child = r.last();
    expect(child.command).toBe(LAUNCH.command);
    expect(child.args).toEqual([
      "--disable-sigusr1",
      "--use-system-ca",
      LAUNCH.entry,
      "--host",
      "127.0.0.1",
      "--port",
      "7860",
      "--no-open",
    ]);
    expect(child.options).toMatchObject({
      cwd: "/Users/me",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    expect(child.options.detached).toBeUndefined();
    expect(child.options.env).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "zh_CN.UTF-8",
      EIDOLON_HOME: HOME,
      EIDOLON_APP_ROOT: LAUNCH.appRoot,
      EIDOLON_NO_DOTENV: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(r.controller.state).toEqual({ phase: "starting" });
    child.listen(7860);
    expect(r.controller.state).toMatchObject({
      phase: "ready",
      origin: "http://127.0.0.1:7860",
      owned: true,
      pid: child.pid,
    });
    expect(ready(r).token.secret).toBe(TOKEN_A);
  });

  test("its flags are jsRuntime()'s inside Electron", () => {
    const restore = asElectron();
    try {
      expect([...BACKEND_RUNTIME_ARGS]).toEqual([...jsRuntime().args]);
    } finally {
      restore();
    }
  });

  test("packaged, the payload's bundle with EIDOLON_APP_ROOT; in dev, this checkout's source without it", () => {
    expect(
      backendLaunch({
        packaged: true,
        execPath: "/A/Eidolon",
        resourcesPath: "/A/Resources",
        appPath: "/A/Resources/app.asar",
      }),
    ).toEqual({
      command: "/A/Eidolon",
      entry: join("/A/Resources", "eidolon", "dist", "server.js"),
      appRoot: join("/A/Resources", "eidolon"),
    });
    const desktop = resolve(import.meta.dirname, "..");
    const dev = backendLaunch({
      packaged: false,
      execPath: "/dev/Electron",
      resourcesPath: "/dev/Resources",
      appPath: desktop,
    });
    expect(dev).toEqual({
      command: "/dev/Electron",
      entry: resolve(desktop, "..", "bot", "src", "local", "server.ts"),
      appRoot: null,
    });
    expect(existsSync(dev.entry)).toBe(true);
    expect(
      backendEnv(
        { EIDOLON_APP_ROOT: "/stale/payload", EIDOLON_HOME: "relative", PATH: "/bin" },
        { home: HOME, appRoot: null, platform: "darwin" },
      ),
    ).toEqual({
      PATH: "/bin",
      EIDOLON_HOME: HOME,
      EIDOLON_NO_DOTENV: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });

  test("on Windows sets its variables over any spelling of them, and keeps Path as it is", () => {
    expect(
      backendEnv(
        {
          Path: "C:\\Windows",
          eidolon_app_root: "C:\\stale",
          Electron_Run_As_Node: "0",
          Eidolon_Home: "C:\\elsewhere",
          eidolon_no_dotenv: "0",
        },
        { home: "C:\\Users\\me\\.laplace\\eidolon", appRoot: "C:\\eidolon", platform: "win32" },
      ),
    ).toEqual({
      Path: "C:\\Windows",
      EIDOLON_HOME: "C:\\Users\\me\\.laplace\\eidolon",
      EIDOLON_APP_ROOT: "C:\\eidolon",
      EIDOLON_NO_DOTENV: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(
      backendEnv({ electron_run_as_node: "x" }, { home: "/h", appRoot: null, platform: "darwin" }),
    ).toMatchObject({ electron_run_as_node: "x", ELECTRON_RUN_AS_NODE: "1" });
  });

  test("reads the environment before every spawn", async () => {
    let reads = 0;
    const r = rig({
      environment: async () => {
        reads++;
        return { PATH: `/read/${reads}` };
      },
    });
    const first = await running(r);
    first.exit(75);
    await settle();
    expect(reads).toBe(2);
    expect(r.children.map((child) => child.options.env?.PATH)).toEqual(["/read/1", "/read/2"]);
  });
});

describe("the port", () => {
  test("is free 0 at once when a test bind finds 7860 taken", async () => {
    const r = rig();
    r.taken.add(7860);
    r.controller.start();
    await settle();
    expect(r.last().port).toBe("0");
    r.last().listen(54321);
    expect(ready(r).origin).toBe("http://127.0.0.1:54321");
  });

  test("a test bind counts EADDRINUSE and EACCES as taken, nothing else", () => {
    expect(isTakenPortError(Object.assign(new Error("x"), { code: "EADDRINUSE" }))).toBe(true);
    expect(isTakenPortError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(true);
    expect(isTakenPortError(Object.assign(new Error("x"), { code: "EADDRNOTAVAIL" }))).toBe(false);
    expect(isTakenPortError(null)).toBe(false);
  });

  test("the test bind itself, on a port another listener holds and then frees", async () => {
    vi.useRealTimers();
    const holder = createServer();
    await new Promise<void>((done) => holder.listen({ host: "127.0.0.1", port: 0 }, done));
    const { port } = holder.address() as { port: number };
    expect(await processIo.portTaken(port)).toBe(true);
    await new Promise((done) => holder.close(done));
    expect(await processIo.portTaken(port)).toBe(false);
  });

  test("a race lost at boot, port 7860 taken or listen EACCES, starts again on port 0", async () => {
    for (const complaint of [
      "eidolon: port 7860 is taken by another program; choose one with --port",
      "Eidolon failed to start Error: listen EACCES: permission denied 127.0.0.1:7860",
    ]) {
      const r = rig();
      r.controller.start();
      await settle();
      r.last().complain(complaint);
      r.last().exit(1);
      await settle();
      expect([complaint, r.children.map((child) => child.port)]).toEqual([
        complaint,
        ["7860", "0"],
      ]);
      expect(r.controller.state).toEqual({ phase: "starting" });
    }
  });

  test("a taken port from port 0 itself, or another exit 1 at boot, is a failure", async () => {
    const r = rig();
    r.taken.add(7860);
    r.controller.start();
    await settle();
    r.last().complain("Error: listen EACCES: permission denied 127.0.0.1:0");
    r.last().exit(1);
    await settle();
    expect(r.controller.state).toMatchObject({
      phase: "failed",
      failure: { reason: "exited", code: 1 },
    });
    const other = rig();
    other.controller.start();
    await settle();
    other
      .last()
      .complain("eidolon: /Users/me/.laplace/eidolon/local-token is readable by other users");
    other.last().exit(1);
    await settle();
    expect(other.children).toHaveLength(1);
    expect(other.controller.state).toMatchObject({
      phase: "failed",
      failure: {
        reason: "exited",
        code: 1,
        stderr: ["eidolon: /Users/me/.laplace/eidolon/local-token is readable by other users"],
      },
    });
  });
});

describe("ready", () => {
  test("only on {kind: listening} with a port from 1 to 65535; anything else is logged and ignored", async () => {
    const r = rig();
    r.controller.start();
    await settle();
    const child = r.last();
    for (const message of [
      { kind: "listening", port: 0 },
      { kind: "listening", port: 65536 },
      { kind: "listening", port: "7860" },
      { kind: "listening", port: 7860.5 },
      { kind: "ready", port: 7860 },
      "listening",
      null,
    ]) {
      child.emit("message", message);
    }
    expect(r.controller.state).toEqual({ phase: "starting" });
    expect(r.logs.filter((line) => line.includes("ignored a message"))).toHaveLength(7);
    child.listen(65535);
    expect(ready(r).origin).toBe("http://127.0.0.1:65535");
  });

  test("reads local-token after the first listening and after every respawn, on the port it bound", async () => {
    const r = rig();
    r.taken.add(7860);
    const first = await running(r, 54321);
    expect(ready(r).token.secret).toBe(TOKEN_A);
    // Deleting the file rotates it: the next server writes another.
    r.token = TOKEN_B;
    first.exit(75);
    await settle();
    expect(r.controller.state).toEqual({ phase: "holding", owned: true });
    r.taken.clear();
    const second = r.last();
    expect(second.port).toBe("54321");
    second.listen(54321);
    expect(ready(r)).toMatchObject({ origin: "http://127.0.0.1:54321", owned: true });
    expect(ready(r).token.secret).toBe(TOKEN_B);
  });

  test("with no local-token to read once it listens, fails, and stops it", async () => {
    const r = rig();
    r.token = null;
    const child = await running(r);
    expect(r.controller.state).toMatchObject({ phase: "failed", failure: { reason: "token" } });
    expect(child.connected).toBe(false);
    expect(r.trace).toContain("disconnect");
  });

  test("one attempt at a time: a second start, or one while ready, does nothing", async () => {
    const r = rig();
    r.controller.start();
    r.controller.start();
    await settle();
    expect(r.children).toHaveLength(1);
    r.last().listen(7860);
    r.controller.start();
    await settle();
    expect(r.children).toHaveLength(1);
  });
});

describe("attaching", () => {
  test("to a live server the hint names that proves itself: nothing spawns", async () => {
    for (const host of ["127.0.0.1", "[::1]"]) {
      const r = rig();
      const origin = await attached(r, host);
      expect(r.probes).toEqual([origin]);
      expect(r.children).toEqual([]);
      expect(ready(r).token.secret).toBe(TOKEN_A);
    }
  });

  test("never to a dead pid, a failed probe, an older server's .info with no host, or with no token", async () => {
    const cases: [string, (r: Rig) => void][] = [
      ["dead", (r) => (r.alive = () => false)],
      ["unproven", (r) => (r.proves = () => false)],
      ["no host", (r) => (r.info = { pid: 4242, port: 7861, host: null })],
      ["no token", (r) => (r.token = null)],
    ];
    for (const [name, arrange] of cases) {
      const r = rig();
      r.info = { pid: 4242, port: 7861, host: "127.0.0.1" };
      r.proves = () => true;
      arrange(r);
      r.controller.start();
      await settle();
      expect([name, r.children.length, r.controller.state.phase]).toEqual([name, 1, "starting"]);
    }
  });
});

describe("a refused spawn", () => {
  test("exit 0 after 'Eidolon is already running:': waits for the holder to prove itself, then attaches", async () => {
    const r = rig();
    r.controller.start();
    await settle();
    r.last().print(`Eidolon is already running: http://127.0.0.1:7860/${LINK}`);
    r.last().exit(0);
    await settle();
    expect(r.controller.state).toEqual({ phase: "starting" });
    expect(r.backendLines.join("\n")).not.toContain("already running");
    await vi.advanceTimersByTimeAsync(2000);
    // The holder records its address, and answers.
    r.info = { pid: 4242, port: 7860, host: "127.0.0.1" };
    r.proves = () => true;
    await vi.advanceTimersByTimeAsync(500);
    expect(r.controller.state).toMatchObject({
      phase: "ready",
      origin: "http://127.0.0.1:7860",
      owned: false,
    });
    expect(r.children).toHaveLength(1);
  });

  test("exit 2 on another port: probes every 500 ms for 60 s, never spawns, then fails naming the holder", async () => {
    const r = rig();
    r.controller.start();
    await settle();
    r.info = { pid: 4242, port: 7861, host: "127.0.0.1" };
    r.last().complain(
      "eidolon: Eidolon is already running on this data home (pid 4242, port 7861); stop it first",
    );
    r.last().exit(2);
    await settle();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(r.controller.state).toEqual({ phase: "starting" });
    await vi.advanceTimersByTimeAsync(1);
    expect(r.probes).toHaveLength(121);
    expect(new Set(r.probes)).toEqual(new Set(["http://127.0.0.1:7861"]));
    expect(r.children).toHaveLength(1);
    expect(r.controller.state).toMatchObject({
      phase: "failed",
      failure: {
        reason: "held",
        holder: { pid: 4242, port: 7861 },
        stderr: [
          "eidolon: Eidolon is already running on this data home (pid 4242, port 7861); stop it first",
        ],
      },
    });
  });

  test("an older server, with no host to attach at, is named by its .info once the wait ends", async () => {
    const r = rig();
    r.taken.add(7860);
    r.info = { pid: 777, port: 7860, host: null };
    r.controller.start();
    await settle();
    r.last().complain(
      "eidolon: Eidolon is already running on this data home (pid 777, port 7860); stop it first",
    );
    r.last().exit(2);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.probes).toEqual([]);
    expect(r.controller.state).toMatchObject({
      phase: "failed",
      failure: { reason: "held", holder: { pid: 777, port: 7860 } },
    });
  });

  test("exit 2 naming only a pid: attaches once the holder has recorded where it listens", async () => {
    const r = rig();
    r.controller.start();
    await settle();
    r.info = { pid: 4242, port: null, host: null };
    r.last().complain(
      "eidolon: Eidolon is already running on this data home (pid 4242); stop it first",
    );
    r.last().exit(2);
    await settle();
    await vi.advanceTimersByTimeAsync(1500);
    r.info = { pid: 4242, port: 7861, host: "[::1]" };
    r.proves = () => true;
    await vi.advanceTimersByTimeAsync(500);
    expect(r.controller.state).toMatchObject({
      phase: "ready",
      origin: "http://[::1]:7861",
      owned: false,
    });
    expect(r.children).toHaveLength(1);
  });

  test("Try Again after it failed starts a new attempt", async () => {
    const r = rig();
    r.controller.start();
    await settle();
    r.last().complain(
      "eidolon: Eidolon is already running on this data home (pid 4242); stop it first",
    );
    r.last().exit(2);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.controller.state.phase).toBe("failed");
    r.controller.start();
    await settle();
    expect(r.children).toHaveLength(2);
  });
});

describe("while attached", () => {
  test("a connection closing holds requests for one probe, then resumes", async () => {
    const r = rig();
    const origin = await attached(r);
    const before = r.controller.state;
    r.controller.disconnected(origin);
    expect(r.controller.state).toEqual({ phase: "holding", owned: false });
    await settle();
    expect(r.controller.state).toMatchObject({ phase: "ready", origin, owned: false });
    expect(r.controller.state).not.toBe(before);
    expect(r.probes).toEqual([origin, origin]);
  });

  test("a disconnect elsewhere, or from our own server, is no change", async () => {
    const r = rig();
    const origin = await attached(r);
    r.controller.disconnected("http://127.0.0.1:5173");
    expect(r.controller.state).toMatchObject({ phase: "ready", origin });
    const own = rig();
    await running(own);
    own.controller.disconnected("http://127.0.0.1:7860");
    expect(own.controller.state).toMatchObject({ phase: "ready", owned: true });
  });

  test("a refused connection: probes every 500 ms, re-reading the hint, and attaches where it points next", async () => {
    const r = rig();
    const origin = await attached(r);
    r.proves = () => false;
    r.controller.refused(origin);
    expect(r.controller.state).toEqual({ phase: "holding", owned: false });
    await vi.advanceTimersByTimeAsync(3000);
    r.info = { pid: 4343, port: 7999, host: "127.0.0.1" };
    r.proves = (at) => at === "http://127.0.0.1:7999";
    await vi.advanceTimersByTimeAsync(500);
    expect(r.controller.state).toMatchObject({
      phase: "ready",
      origin: "http://127.0.0.1:7999",
      owned: false,
    });
    expect(r.probes.slice(-2)).toEqual([origin, "http://127.0.0.1:7999"]);
    expect(r.children).toEqual([]);
  });

  test("a forwarded restart starts the same grace period", async () => {
    const r = rig();
    const origin = await attached(r);
    r.proves = () => false;
    r.controller.restarted(origin);
    expect(r.controller.state).toEqual({ phase: "holding", owned: false });
    r.proves = () => true;
    await vi.advanceTimersByTimeAsync(500);
    expect(r.controller.state).toMatchObject({ phase: "ready", origin, owned: false });
  });

  test("60 s with no server on the data home: our own starts on that port, under the refusal rule", async () => {
    const r = rig();
    const origin = await attached(r, "127.0.0.1", 7861);
    r.proves = () => false;
    r.controller.refused(origin);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(r.children).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(r.children).toHaveLength(1);
    expect(r.last().port).toBe("7861");
    expect(r.controller.state).toEqual({ phase: "starting" });
    r.last().complain(
      "eidolon: Eidolon is already running on this data home (pid 4242, port 7861); stop it first",
    );
    r.last().exit(2);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.children).toHaveLength(1);
    expect(r.controller.state).toMatchObject({ phase: "failed", failure: { reason: "held" } });
  });

  test("stopping leaves it running: no signal, no disconnect", async () => {
    const r = rig();
    await attached(r);
    const stopped = r.controller.stop();
    expect(r.controller.state).toEqual({ phase: "holding", owned: false });
    await stopped;
    expect(r.controller.state).toEqual({ phase: "stopped" });
    expect(r.trace.filter((line) => !line.startsWith("alive?"))).toEqual([]);
  });
});

describe("a new connection the forwarder opens", () => {
  const socket = new Socket();

  test("to our own server is proved over itself, with the token read once it listened", async () => {
    const r = rig();
    await running(r);
    r.proves = (origin, secret) => origin === "http://127.0.0.1:7860" && secret === TOKEN_A;
    expect(await r.controller.proveConnection(socket, "http://127.0.0.1:7860")).toBe(true);
    r.proves = () => false;
    expect(await r.controller.proveConnection(socket, "http://127.0.0.1:7860")).toBe(false);
    expect(r.connectionProofs).toEqual([
      ["http://127.0.0.1:7860", TOKEN_A],
      ["http://127.0.0.1:7860", TOKEN_A],
    ]);
  });

  test("never to another address, and never while no server is ready", async () => {
    const r = rig();
    r.proves = () => true;
    r.controller.start();
    expect(await r.controller.proveConnection(socket, "http://127.0.0.1:7860")).toBe(false);
    await settle();
    const child = r.last();
    child.listen(7860);
    expect(await r.controller.proveConnection(socket, "http://127.0.0.1:7861")).toBe(false);
    expect(await r.controller.proveConnection(socket, "http://[::1]:7860")).toBe(false);
    r.controller.restarted("http://127.0.0.1:7860");
    expect(await r.controller.proveConnection(socket, "http://127.0.0.1:7860")).toBe(false);
    child.exit(1);
    await settle();
    expect(r.controller.state.phase).toBe("failed");
    expect(await r.controller.proveConnection(socket, "http://127.0.0.1:7860")).toBe(false);
    expect(r.connectionProofs).toEqual([]);
  });

  test("to an attached server, only while its hint still names that address and a live pid", async () => {
    const r = rig();
    const origin = await attached(r);
    expect(await r.controller.proveConnection(socket, origin)).toBe(true);
    // It moved: whatever holds its old address now could pass the probe on to it.
    r.proves = () => true;
    r.info = { pid: 4343, port: 7999, host: "127.0.0.1" };
    expect(await r.controller.proveConnection(socket, origin)).toBe(false);
    r.info = { pid: 4242, port: 7861, host: "[::1]" };
    expect(await r.controller.proveConnection(socket, origin)).toBe(false);
    r.info = null;
    expect(await r.controller.proveConnection(socket, origin)).toBe(false);
    r.info = { pid: 4242, port: 7861, host: "127.0.0.1" };
    r.alive = () => false;
    expect(await r.controller.proveConnection(socket, origin)).toBe(false);
    expect(r.connectionProofs).toEqual([[origin, TOKEN_A]]);
  });
});

describe("our own server", () => {
  test("a forwarded restart holds requests until the new backend listens on the same port", async () => {
    const r = rig();
    const first = await running(r);
    r.controller.restarted("http://127.0.0.1:9999");
    expect(r.controller.state.phase).toBe("ready");
    r.controller.restarted("http://127.0.0.1:7860");
    expect(r.controller.state).toEqual({ phase: "holding", owned: true });
    first.exit(75);
    await settle();
    expect(r.controller.state).toEqual({ phase: "holding", owned: true });
    expect(r.last().port).toBe("7860");
    r.last().listen(7860);
    expect(ready(r).owned).toBe(true);
  });

  test("a refused connection holds until it answers a probe again", async () => {
    const r = rig();
    await running(r);
    const before = ready(r);
    r.controller.refused("http://127.0.0.1:7860");
    expect(r.controller.state).toEqual({ phase: "holding", owned: true });
    r.proves = (origin, secret) => origin === "http://127.0.0.1:7860" && secret === TOKEN_A;
    await vi.advanceTimersByTimeAsync(500);
    expect(r.controller.state).toBe(before);
  });

  test("a refused connection and 60 s of silence fail, and stop it", async () => {
    const r = rig();
    const child = await running(r);
    r.controller.refused("http://127.0.0.1:7860");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.controller.state).toMatchObject({
      phase: "failed",
      failure: { reason: "unanswered" },
    });
    expect(child.connected).toBe(false);
  });

  test("an exit other than 75 fails, with the last lines of stderr", async () => {
    const r = rig();
    const child = await running(r);
    for (let line = 1; line <= 40; line++) child.complain(`line ${line}`);
    child.print(`Eidolon is ready: http://127.0.0.1:7860/${LINK}`);
    child.exit(1);
    await settle();
    expect(r.controller.state).toMatchObject({
      phase: "failed",
      failure: { reason: "exited", code: 1, signal: null },
    });
    const { failure } = r.controller.state as Extract<BackendState, { phase: "failed" }>;
    expect(failure.stderr).toHaveLength(30);
    expect(failure.stderr.at(-1)).toBe("line 40");
    expect(r.backendLines).toContain("stderr: line 1");
    expect(r.backendLines.join("\n")).not.toContain(LINK);
  });

  test("what it wrote while it booted isn't a later failure's: the tail starts when it listens", async () => {
    const r = rig();
    r.controller.start();
    await settle();
    const child = r.last();
    child.complain(
      "Persona facts: no LanceDB table. Run `bun run laplace-ingest-facts` to build it.",
    );
    await settle();
    child.listen(7860);
    child.complain("boom");
    child.exit(1);
    await settle();
    const { failure } = r.controller.state as Extract<BackendState, { phase: "failed" }>;
    expect(failure.stderr).toEqual(["boom"]);
    expect(r.backendLines).toContain(
      "stderr: Persona facts: no LanceDB table. Run `bun run laplace-ingest-facts` to build it.",
    );
  });

  test("a signal, or an exit 0 it wasn't asked for, fails too", async () => {
    for (const [code, signal] of [
      [null, "SIGKILL"],
      [0, null],
    ] as const) {
      const r = rig();
      const child = await running(r);
      child.exit(code, signal);
      await settle();
      expect(r.controller.state).toMatchObject({ phase: "failed", failure: { code, signal } });
    }
  });

  test("no listening within 60 s fails and stops it; Try Again waits for it to be gone", async () => {
    const r = rig();
    r.controller.start();
    await settle();
    const stuck = r.last();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(r.controller.state).toEqual({ phase: "starting" });
    await vi.advanceTimersByTimeAsync(1);
    expect(r.controller.state).toMatchObject({
      phase: "failed",
      failure: { reason: "no-listening" },
    });
    expect(r.trace).toContain("disconnect");
    r.controller.start();
    await settle();
    expect(r.children).toHaveLength(1);
    stuck.exit(0);
    await settle();
    expect(r.children).toHaveLength(2);
  });

  test("a backend that can't be started, or an environment that can't be read, fails", async () => {
    const r = rig({
      io: {
        spawn: (command, args, options) => {
          const child = new FakeChild(command, args, options, [], false);
          setTimeout(() =>
            child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
          );
          return child;
        },
      },
    });
    r.controller.start();
    await settle();
    expect(r.controller.state).toMatchObject({
      phase: "failed",
      failure: { reason: "error", message: "spawn ENOENT" },
    });
    const broken = rig({
      environment: () => {
        throw new Error("no environment");
      },
    });
    broken.controller.start();
    await settle();
    expect(broken.controller.state).toMatchObject({
      phase: "failed",
      failure: { reason: "error", message: "no environment" },
    });
  });
});

describe("the 60 s waits", () => {
  test("count the timers' time, which stops while a Mac sleeps, not the wall clock's", async () => {
    const waits: [string, (r: Rig) => Promise<BackendState>][] = [
      [
        "our own backend's hold",
        async (r) => {
          await running(r);
          r.controller.refused("http://127.0.0.1:7860");
          return { phase: "holding", owned: true };
        },
      ],
      [
        "an attached server's grace",
        async (r) => {
          const origin = await attached(r);
          r.proves = () => false;
          r.controller.refused(origin);
          return { phase: "holding", owned: false };
        },
      ],
      [
        "the wait after a refused spawn",
        async (r) => {
          r.controller.start();
          await settle();
          r.info = { pid: 4242, port: 7861, host: "127.0.0.1" };
          r.last().complain(
            "eidolon: Eidolon is already running on this data home (pid 4242, port 7861); stop it first",
          );
          r.last().exit(2);
          await settle();
          return { phase: "starting" };
        },
      ],
    ];
    for (const [wait, begin] of waits) {
      const r = rig();
      const waiting = await begin(r);
      const spawned = r.children.length;
      await vi.advanceTimersByTimeAsync(1200);
      // The lid closes for an hour.
      vi.setSystemTime(Date.now() + 3_600_000);
      await vi.advanceTimersByTimeAsync(1000);
      expect([wait, r.controller.state, r.children.length]).toEqual([wait, waiting, spawned]);
      r.proves = () => true;
      await vi.advanceTimersByTimeAsync(500);
      expect([wait, r.controller.state.phase]).toEqual([wait, "ready"]);
    }
  });
});

describe("the stop", () => {
  test("closes the IPC channel, then kill() after 10 s and SIGKILL 5 s later on macOS, then gives up", async () => {
    const r = rig();
    const child = await running(r);
    const stopped = r.controller.stop();
    expect(r.trace.at(-1)).toBe("disconnect");
    // No Bearer from the stop on: the backend closes its listener long before it exits.
    expect(r.controller.state).toEqual({ phase: "holding", owned: true });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kills).toEqual([undefined]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kills).toEqual([undefined, "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
    expect(r.controller.state).toEqual({ phase: "stopped" });
    expect(r.logs.at(-1)).toContain("giving up");
  });

  test("on Windows, kill() is TerminateProcess and nothing follows it", async () => {
    const r = rig({ platform: "win32" });
    const child = await running(r);
    const stopped = r.controller.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    await stopped;
    expect(child.kills).toEqual([undefined]);
    expect(r.controller.state).toEqual({ phase: "stopped" });
  });

  test("a backend that stops on the disconnect gets no signal, and its exit is no failure", async () => {
    const r = rig();
    const child = await running(r);
    const stopped = r.controller.stop();
    child.exit(0);
    await stopped;
    expect(child.kills).toEqual([]);
    expect(r.states.map((state) => state.phase)).toEqual(["ready", "holding", "stopped"]);
  });

  test("nothing starts after it: no restart, no Try Again, no grace", async () => {
    const r = rig();
    const child = await running(r);
    const stopped = r.controller.stop();
    child.exit(75);
    await stopped;
    r.controller.start();
    r.controller.refused("http://127.0.0.1:7860");
    await settle();
    expect(r.children).toHaveLength(1);
    expect(r.controller.state).toEqual({ phase: "stopped" });
  });
});

describe("the Windows session end", () => {
  test("issues the stop trigger before any synchronous wait", async () => {
    const r = rig({ platform: "win32" });
    const child = await running(r);
    r.trace.length = 0;
    let polls = 0;
    r.alive = () => ++polls < 3;
    // query-session-end: the trigger alone; Node closes the channel on the next tick.
    r.controller.sessionEnding();
    expect(r.trace).toEqual(["disconnect"]);
    // session-end: only now the wait, polling the pid.
    r.controller.sessionEnded();
    expect(r.trace).toEqual([
      "disconnect",
      `alive? ${child.pid}`,
      "sleep 50",
      `alive? ${child.pid}`,
      "sleep 50",
      `alive? ${child.pid}`,
    ]);
  });

  test("waits about 4 s at most", async () => {
    const r = rig({ platform: "win32" });
    await running(r);
    r.alive = () => true;
    r.controller.sessionEnding();
    const started = Date.now();
    r.controller.sessionEnded();
    expect(Date.now() - started).toBe(4000);
    expect(r.trace.filter((line) => line === "sleep 50")).toHaveLength(80);
  });

  test("waits as long for a stop already under way: a quit's, or a failure's", async () => {
    const stops: [string, (r: Rig) => Promise<void>][] = [
      // The owner approved a quit with a task running, and signs out while the backend stops it.
      ["a quit", async (r) => void r.controller.stop()],
      [
        "a failure",
        async (r) => {
          r.controller.refused("http://127.0.0.1:7860");
          await vi.advanceTimersByTimeAsync(60_000);
          expect(r.controller.state.phase).toBe("failed");
        },
      ],
    ];
    for (const [why, stopping] of stops) {
      const r = rig({ platform: "win32" });
      const child = await running(r);
      await stopping(r);
      expect([why, child.connected]).toEqual([why, false]);
      r.trace.length = 0;
      let polls = 0;
      r.alive = () => ++polls < 3;
      r.controller.sessionEnding();
      r.controller.sessionEnded();
      const alive = `alive? ${child.pid}`;
      expect([why, r.trace]).toEqual([why, [alive, "sleep 50", alive, "sleep 50", alive]]);
    }
  });

  test("an exit seen before session-end leaves nothing to wait for", async () => {
    const r = rig({ platform: "win32" });
    const child = await running(r);
    r.controller.sessionEnding();
    child.exit(0);
    await settle();
    r.trace.length = 0;
    r.controller.sessionEnded();
    expect(r.trace).toEqual([]);
  });

  test("a vetoed shutdown starts the backend again instead of failing", async () => {
    const r = rig({ platform: "win32" });
    const child = await running(r);
    r.controller.sessionEnding();
    child.exit(0);
    await settle();
    expect(r.controller.state).toEqual({ phase: "holding", owned: true });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(r.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(r.children).toHaveLength(2);
    expect(r.last().port).toBe("7860");
    r.last().listen(7860);
    expect(ready(r).owned).toBe(true);
    expect(r.states.some((state) => state.phase === "failed")).toBe(false);
  });

  test("stops nothing of an attached server's", async () => {
    const r = rig({ platform: "win32" });
    await attached(r);
    r.trace.length = 0;
    r.controller.sessionEnding();
    r.controller.sessionEnded();
    expect(r.trace).toEqual([]);
    expect(r.controller.state).toMatchObject({ phase: "ready", owned: false });
  });
});

describe("its events", () => {
  test("follow every change, and a listener that throws stops nothing", async () => {
    const r = rig();
    r.controller.subscribe(() => {
      throw new Error("a broken window");
    });
    await running(r);
    expect(r.states.map((state) => state.phase)).toEqual(["ready"]);
    expect(r.logs.some((line) => line.includes("a broken window"))).toBe(true);
  });

  test("print the token as nothing", async () => {
    const r = rig();
    await running(r);
    expect(JSON.stringify(r.controller.state)).not.toContain(TOKEN_A);
  });
});
