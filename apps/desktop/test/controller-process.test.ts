// The controller and the forwarder against real processes: a plain script that answers as the local
// server does (IPC listening, probe proofs, the Bearer, exit 75 on restart, a stop on the channel's
// close), on temporary homes and ports the OS picks.
import "../../../packages/config/test/isolated-guard.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isAlive } from "../src/main/attach.ts";
import { BackendController, type BackendState, type ReadyState } from "../src/main/controller.ts";
import { createForwarder, type Forwarder } from "../src/main/forwarder.ts";

const FAKE_SERVER = `
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const home = process.env.EIDOLON_HOME;
const argv = process.argv.slice(2);
appendFileSync(join(home, "runs.ndjson"), JSON.stringify({
  pid: process.pid,
  execArgv: process.execArgv,
  argv,
  cwd: process.cwd(),
  env: {
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
    EIDOLON_NO_DOTENV: process.env.EIDOLON_NO_DOTENV ?? null,
    EIDOLON_APP_ROOT: process.env.EIDOLON_APP_ROOT ?? null,
    EIDOLON_HOME: home,
  },
}) + "\\n");
const secret = readFileSync(join(home, "local-token"), "utf8").trim();
const sign = (message) => createHmac("sha256", secret).update(message, "utf8").digest("base64url");
const info = join(home, "locks", "4273f434b594.info");
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://x");
  if (url.pathname === "/api/local/session" && url.searchParams.has("probe")) {
    response.end(JSON.stringify({ proof: sign("probe:" + url.searchParams.get("probe")) }));
  } else if (request.headers.authorization !== "Bearer " + secret) {
    response.writeHead(401).end();
  } else if (request.method === "POST" && url.pathname === "/api/local/restart") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    setTimeout(() => stop(75), 100);
  } else {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pid: process.pid }));
  }
});
function stop(code) {
  server.close();
  server.closeAllConnections();
  rmSync(info, { force: true });
  process.exit(code);
}
server.listen({ host: "127.0.0.1", port: Number(argv[argv.indexOf("--port") + 1]) }, () => {
  const { port } = server.address();
  if (process.env.FAKE_RECORDS_INFO === "1") {
    mkdirSync(join(home, "locks"), { recursive: true });
    writeFileSync(info, JSON.stringify({ pid: process.pid, command: "eidolon", key: "local-server", start: "now", port, host: "127.0.0.1" }));
  }
  process.send?.({ kind: "listening", port });
  process.stdout.write("Eidolon is ready: http://127.0.0.1:" + port + "/#1793000000." + "d".repeat(43) + "\\n");
  process.stderr.write("[local] listening on " + port + "\\n");
});
process.on("disconnect", () => stop(0));
process.on("SIGTERM", () => stop(0));
`;

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);

let dir: string;
let home: string;
let script: string;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eidolon-desktop-process-"));
  home = join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "local-token"), `${TOKEN_A}\n`, { mode: 0o600 });
  script = join(dir, "server.mjs");
  writeFileSync(script, FAKE_SERVER);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

/** What a test's backend runs with: no developer keys, and every Eidolon folder a temporary one. */
function environment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    EIDOLON_REAL_HOME: join(dir, "real-home"),
    EIDOLON_SHARED_SKILLS: join(dir, "shared-skills"),
  };
}

function runs(): { pid: number; execArgv: string[]; argv: string[]; cwd: string; env: object }[] {
  return readFileSync(join(home, "runs.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

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
    waitingPage: () => "<!doctype html><title>Eidolon</title>",
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
  expect(await status.json()).toEqual({ pid: run?.pid });

  // Deleting local-token rotates it: the next server makes another, which main must read again.
  writeFileSync(join(home, "local-token"), `${TOKEN_B}\n`, { mode: 0o600 });
  const restart = await forwarder.handle(app("/api/local/restart", { method: "POST" }));
  expect(restart.status).toBe(200);
  expect(controller.state).toEqual({ phase: "holding", owned: true });
  // Held through the gap, then forwarded to the new server with the new token.
  const held = await forwarder.handle(app("/api/local/status"));
  expect(held.status).toBe(200);
  const second = runs()[1];
  expect(await held.json()).toEqual({ pid: second?.pid });
  expect(second?.argv).toEqual(["--host", "127.0.0.1", "--port", String(port), "--no-open"]);
  expect(controller.state).toMatchObject({ phase: "ready", origin: first.origin, owned: true });
  expect((controller.state as ReadyState).token.secret).toBe(TOKEN_B);

  await controller.stop();
  expect(controller.state).toEqual({ phase: "stopped" });
  expect(isAlive(second?.pid as number)).toBe(false);
  expect(lines).toContain(`stderr: [local] listening on ${port}`);
  expect(lines.some((line) => line.includes("Eidolon is ready"))).toBe(false);
});

/** A terminal's server on the data home, as `bun run app` runs it, which records where it listens. */
function terminalServer(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [script, "--host", "127.0.0.1", "--port", String(port), "--no-open"],
    {
      env: { ...environment(), EIDOLON_HOME: home, FAKE_RECORDS_INFO: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((done) => child.once("exit", done));
    }
  });
  return new Promise((done, fail) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Eidolon is ready")) done(child);
    });
    child.once("exit", (code) => fail(new Error(`the terminal's server exited ${code}`)));
  });
}

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
  expect(controller.state).toMatchObject({ origin: `http://127.0.0.1:${port}`, owned: false });
  const before = await forwarder.handle(app("/api/local/status"));
  expect(await before.json()).toEqual({ pid: terminal.pid });

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
  expect(await after.json()).toEqual({ pid: replacement.pid });
  expect(runs()).toHaveLength(2);

  await controller.stop();
  expect(replacement.exitCode).toBeNull();
  expect(isAlive(replacement.pid as number)).toBe(true);
});
