// The controller and the forwarder against real processes: test/fake-server.ts's script, which
// answers as the local server does, on temporary homes and ports the OS picks.
import "../../../packages/config/test/isolated-guard.ts";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isAlive } from "../src/main/attach.ts";
import { BackendController, type BackendState, type ReadyState } from "../src/main/controller.ts";
import { createForwarder, type Forwarder } from "../src/main/forwarder.ts";
import {
  environment as environmentIn,
  makeHome,
  runs as runsOn,
  terminalServer as terminalServerOn,
  writeFakeServer,
} from "./fake-server.ts";

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);

let dir: string;
let home: string;
let script: string;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eidolon-desktop-process-"));
  home = join(dir, "home");
  makeHome(home, TOKEN_A);
  script = join(dir, "server.mjs");
  writeFakeServer(script);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const environment = (): NodeJS.ProcessEnv => environmentIn(dir);
const runs = () => runsOn(home);

/** A terminal's server on the data home, as `bun run app` runs it, which records where it listens. */
const terminalServer = (port: number, keepAliveMs?: number) =>
  terminalServerOn({ script, home, dir, port, keepAliveMs }, cleanups);

/** Resolves with the first state `accept` takes. */
function next(
  controller: BackendController,
  accept: (state: BackendState) => boolean,
): Promise<BackendState> {
  if (accept(controller.state)) return Promise.resolve(controller.state);
  return new Promise((done) => {
    const stop = controller.subscribe((state) => {
      if (accept(state)) {
        stop();
        done(state);
      }
    });
  });
}

function app(path: string, init: RequestInit = {}): Request {
  const request = new Request(`eidolon-app://app${path}`, init);
  Object.defineProperty(request, "initiatorOrigin", { value: "eidolon-app://app" });
  return request;
}

function forwarderFor(controller: BackendController): Forwarder {
  const forwarder = createForwarder({
    backend: controller,
    waitingPage: async () => new Response("<!doctype html><title>Eidolon</title>"),
    log: { warn: () => {} },
  });
  cleanups.push(() => forwarder.destroy());
  return forwarder;
}

test("our own backend: listens, takes the Bearer, restarts on its port with the token re-read, stops on the disconnect", async () => {
  const lines: string[] = [];
  const controller = new BackendController({
    home,
    launch: { command: process.execPath, entry: script, appRoot: join(dir, "payload") },
    environment,
    backendLog: (stream, line) => lines.push(`${stream}: ${line}`),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: 0,
    cwd: dir,
  });
  cleanups.push(() => controller.stop());
  const forwarder = forwarderFor(controller);
  controller.start();
  const first = (await next(controller, (state) => state.phase !== "starting")) as ReadyState;
  expect(first).toMatchObject({ phase: "ready", owned: true });
  const port = Number(new URL(first.origin).port);

  const [run] = runs();
  expect(first.pid).toBe(run?.pid);
  expect(run).toMatchObject({
    execArgv: ["--disable-sigusr1", "--use-system-ca"],
    argv: ["--host", "127.0.0.1", "--port", "0", "--no-open"],
    cwd: realpathSync(dir),
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      EIDOLON_NO_DOTENV: "1",
      EIDOLON_APP_ROOT: join(dir, "payload"),
      EIDOLON_HOME: home,
    },
  });
  const status = await forwarder.handle(app("/api/local/status"));
  expect(await status.json()).toMatchObject({ pid: run?.pid });

  // Deleting local-token rotates it: the next server makes another, which main must read again.
  writeFileSync(join(home, "local-token"), `${TOKEN_B}\n`, { mode: 0o600 });
  const restart = await forwarder.handle(app("/api/local/restart", { method: "POST" }));
  expect(restart.status).toBe(200);
  expect(controller.state).toEqual({ phase: "holding", owned: true });
  // Held through the gap, then forwarded to the new server with the new token.
  const held = await forwarder.handle(app("/api/local/status"));
  expect(held.status).toBe(200);
  const second = runs()[1];
  expect(await held.json()).toMatchObject({ pid: second?.pid });
  expect(second?.argv).toEqual(["--host", "127.0.0.1", "--port", String(port), "--no-open"]);
  expect(controller.state).toMatchObject({
    phase: "ready",
    origin: first.origin,
    owned: true,
    pid: second?.pid,
  });
  expect((controller.state as ReadyState).token.secret).toBe(TOKEN_B);

  await controller.stop();
  expect(controller.state).toEqual({ phase: "stopped" });
  expect(isAlive(second?.pid as number)).toBe(false);
  expect(lines).toContain(`stderr: [local] listening on ${port}`);
  expect(lines.some((line) => line.includes("Eidolon is ready"))).toBe(false);
});

test("attached to a terminal's server: a restart started outside the app is a grace period, then the new server", async () => {
  const terminal = await terminalServer(0);
  const { port } = JSON.parse(readFileSync(join(home, "locks", "4273f434b594.info"), "utf8"));
  const controller = new BackendController({
    home,
    launch: { command: process.execPath, entry: script, appRoot: null },
    environment,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: 0,
    cwd: dir,
  });
  cleanups.push(() => controller.stop());
  const phases: string[] = [];
  controller.subscribe((state) =>
    phases.push(`${state.phase}${"owned" in state && !state.owned ? " attached" : ""}`),
  );
  const forwarder = forwarderFor(controller);
  controller.start();
  await next(controller, (state) => state.phase === "ready");
  expect(controller.state).toMatchObject({
    origin: `http://127.0.0.1:${port}`,
    owned: false,
    pid: terminal.pid,
  });
  const before = await forwarder.handle(app("/api/local/status"));
  expect(await before.json()).toMatchObject({ pid: terminal.pid });

  // A browser tab restarts it, and the terminal's supervisor starts the next on the same port.
  const exited = new Promise((done) => terminal.once("exit", done));
  await fetch(`http://127.0.0.1:${port}/api/local/restart`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN_A}` },
  });
  expect(await exited).toBe(75);
  await vi.waitFor(() => expect(phases).toContain("holding attached"), { timeout: 5000 });
  const replacement = await terminalServer(port);
  await vi.waitFor(() => expect(controller.state).toMatchObject({ phase: "ready", owned: false }), {
    timeout: 5000,
  });
  const after = await forwarder.handle(app("/api/local/status"));
  expect(await after.json()).toMatchObject({ pid: replacement.pid });
  expect(runs()).toHaveLength(2);

  await controller.stop();
  expect(replacement.exitCode).toBeNull();
  expect(isAlive(replacement.pid as number)).toBe(true);
});

test("attached and idle with no connection open: a restart from outside on the same port is a new server, attached to before a request reaches it", async () => {
  const terminal = await terminalServer(0, 200);
  const { port } = JSON.parse(readFileSync(join(home, "locks", "4273f434b594.info"), "utf8"));
  const controller = new BackendController({
    home,
    launch: { command: process.execPath, entry: script, appRoot: null },
    environment,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: 0,
    cwd: dir,
  });
  cleanups.push(() => controller.stop());
  const phases: string[] = [];
  const readies: (number | null)[] = [];
  controller.subscribe((state) => {
    phases.push(`${state.phase}${"owned" in state && !state.owned ? " attached" : ""}`);
    if (state.phase === "ready") readies.push(state.pid);
  });
  const forwarder = forwarderFor(controller);
  controller.start();
  await next(controller, (state) => state.phase === "ready");
  expect(await (await forwarder.handle(app("/api/local/status"))).json()).toMatchObject({
    pid: terminal.pid,
  });
  await vi.waitFor(
    () => expect(phases).toEqual(["ready attached", "holding attached", "ready attached"]),
    { timeout: 5000 },
  );

  // A browser tab restarts it, and the terminal's supervisor starts the next on the same port.
  const exited = new Promise((done) => terminal.once("exit", done));
  await fetch(`http://127.0.0.1:${port}/api/local/restart`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN_A}` },
  });
  expect(await exited).toBe(75);
  const replacement = await terminalServer(port);
  expect(phases).toHaveLength(3);

  // The page's next connection finds the hint naming another process: a grace period attaches to
  // it, and only then does the request, sent again, reach it.
  const status = await forwarder.handle(app("/api/local/status"));
  expect(await status.json()).toMatchObject({ pid: replacement.pid });
  expect(phases.slice(3)).toEqual(["holding attached", "ready attached"]);
  expect(readies.slice(2)).toEqual([replacement.pid]);
});

test("attached and idle with no connection open: a restart from outside, and a relay on the old port, get no Bearer", async () => {
  const terminal = await terminalServer(0, 200);
  const { port } = JSON.parse(readFileSync(join(home, "locks", "4273f434b594.info"), "utf8"));
  const controller = new BackendController({
    home,
    launch: { command: process.execPath, entry: script, appRoot: null },
    environment,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: 0,
    cwd: dir,
  });
  cleanups.push(() => controller.stop());
  const phases: string[] = [];
  controller.subscribe((state) =>
    phases.push(`${state.phase}${"owned" in state && !state.owned ? " attached" : ""}`),
  );
  const forwarder = forwarderFor(controller);
  controller.start();
  await next(controller, (state) => state.phase === "ready");
  expect(await (await forwarder.handle(app("/api/local/status"))).json()).toMatchObject({
    pid: terminal.pid,
  });
  // The server closes the idle connection: a grace period proves it again, leaving none open.
  await vi.waitFor(
    () => expect(phases).toEqual(["ready attached", "holding attached", "ready attached"]),
    {
      timeout: 5000,
    },
  );

  // Restarted from a browser tab: the next server starts elsewhere, and something else takes the
  // old port, passing whatever it gets on to the new server, the probe included.
  const exited = new Promise((done) => terminal.once("exit", done));
  await fetch(`http://127.0.0.1:${port}/api/local/restart`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN_A}` },
  });
  expect(await exited).toBe(75);
  const replacement = await terminalServer(0);
  const moved = JSON.parse(readFileSync(join(home, "locks", "4273f434b594.info"), "utf8")).port;
  const relayed: (string | undefined)[] = [];
  const relay = createServer((request, response) => {
    relayed.push(request.headers.authorization);
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: moved,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    request.pipe(upstream);
  });
  let connections = 0;
  relay.on("connection", () => connections++);
  await new Promise<void>((done) => relay.listen({ host: "127.0.0.1", port }, done));
  cleanups.push(() => {
    relay.closeAllConnections();
    return new Promise((done) => relay.close(() => done()));
  });

  const status = await forwarder.handle(app("/api/local/status"));
  expect(await status.json()).toMatchObject({ pid: replacement.pid });
  expect(connections).toBe(1);
  expect(relayed).toEqual([]);
  expect(controller.state).toMatchObject({
    phase: "ready",
    origin: `http://127.0.0.1:${moved}`,
    owned: false,
  });
});
