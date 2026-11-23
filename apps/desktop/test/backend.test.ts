// The Backend over the controller and the forwarder, against real processes (test/fake-server.ts's
// script) on temporary homes: what the window is told, each server's version read once, and the
// quit check for our own backend alone.
import "../../../packages/config/test/isolated-guard.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Backend, licensesFile } from "../src/main/backend.ts";
import type { BackendState } from "../src/main/controller.ts";
import { UNREACHABLE } from "../src/main/forwarder.ts";
import {
  environment,
  makeHome,
  requests,
  runs,
  type TerminalServerOptions,
  terminalServer,
  writeFakeServer,
} from "./fake-server.ts";

const TOKEN = "A".repeat(43);
/** Shorter than any wait below: an idle connection closes, as undici's would after 4 s. */
const KEEP_ALIVE_MS = 100;

let dir: string;
let home: string;
let resources: string;
let script: string;
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eidolon-desktop-backend-"));
  home = join(dir, "home");
  makeHome(home, TOKEN);
  // The packaged payload's server, which our own backend runs.
  resources = join(dir, "resources");
  script = join(resources, "eidolon", "dist", "server.js");
  mkdirSync(join(script, ".."), { recursive: true });
  writeFakeServer(script);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function phase(state: BackendState): string {
  const attached = (state.phase === "ready" || state.phase === "holding") && !state.owned;
  return `${state.phase}${attached ? " attached" : ""}`;
}

/** A Backend on the temporary home, packaged, and what it tells the window. */
function follow(env: NodeJS.ProcessEnv = {}): {
  backend: Backend;
  told: string[];
  /** The process of each ready state told. */
  readies: (number | null)[];
} {
  const told: string[] = [];
  const readies: (number | null)[] = [];
  const quiet = () => {};
  const backend = new Backend({
    app: { packaged: true, execPath: process.execPath, resourcesPath: resources, appPath: dir },
    env: { ...environment(dir), EIDOLON_HOME: home, EIDOLON_DESKTOP_LOGIN_SHELL: "0", ...env },
    log: { info: quiet, warn: quiet, error: quiet },
    backendLog: quiet,
    waitingPage: async () => new Response("<!doctype html><title>Eidolon</title>"),
    port: 0,
  });
  backend.subscribe((state) => {
    told.push(phase(state));
    if (state.phase === "ready") readies.push(state.pid);
  });
  cleanups.push(() => backend.stop());
  return { backend, told, readies };
}

function terminal(options: Partial<TerminalServerOptions> = {}) {
  return terminalServer(
    { script, home, dir, port: 0, keepAliveMs: KEEP_ALIVE_MS, ...options },
    cleanups,
  );
}

/** A request of the app's page. */
function app(path: string, init: RequestInit = {}): Request {
  const request = new Request(`eidolon-app://app${path}`, init);
  Object.defineProperty(request, "initiatorOrigin", { value: "eidolon-app://app" });
  return request;
}

const statusReads = () =>
  requests(home)
    .filter(({ path }) => path === "/api/local/status")
    .map(({ pid }) => pid);

describe("before the environment is read", () => {
  test("the app host answers as with no server: a document waits, a fetch is unreachable", async () => {
    const { backend, told } = follow();
    const page = await backend.handle(app("/", { headers: { accept: "text/html" } }));
    expect([page.status, await page.text()]).toEqual([
      200,
      "<!doctype html><title>Eidolon</title>",
    ]);
    const status = await backend.handle(app("/api/local/status"));
    expect([status.status, await status.json()]).toEqual([503, UNREACHABLE]);
    expect(backend.quitCheck()).toBeNull();
    await expect(backend.get("/api/local/tasks", AbortSignal.timeout(1000))).rejects.toThrow(
      "no server is ready",
    );
    expect(told).toEqual([]);
  });

  test("a stop while it's read, as a quit at startup, starts nothing", async () => {
    const { backend, told } = follow();
    const started = backend.start();
    await backend.stop();
    await started;
    await sleep(500);
    expect(backend.home).toBeNull();
    expect(existsSync(join(home, "runs.ndjson"))).toBe(false);
    expect(told).toEqual([]);
  });
});

describe("attached to a terminal's server", () => {
  test("idle, it stays ready: reading the version once starts no grace period", async () => {
    const server = await terminal({ version: "0.13.0" });
    const { backend, told } = follow();
    await backend.start();
    await vi.waitFor(() => expect(told).toEqual(["ready attached"]));
    expect(backend.serverVersion).toBe("0.13.0");
    // Many times the server's idle close, which once started a grace period that read again.
    await sleep(20 * KEEP_ALIVE_MS);
    expect(told).toEqual(["ready attached"]);
    expect(statusReads()).toEqual([server.pid]);
    expect(backend.quitCheck()).toBeNull();
  });

  test("main's own GET reaches it with the Bearer, and its connections closing start no grace period", async () => {
    const server = await terminal({ version: "0.13.0" });
    const { backend, told } = follow();
    await backend.start();
    await vi.waitFor(() => expect(told).toEqual(["ready attached"]));
    const tasks = await backend.get("/api/local/tasks", AbortSignal.timeout(2000));
    expect([tasks.status, await tasks.json()]).toEqual([200, { pid: server.pid }]);
    await sleep(10 * KEEP_ALIVE_MS);
    expect(told).toEqual(["ready attached"]);
    expect(requests(home).map(({ path }) => path)).toEqual([
      "/api/local/status",
      "/api/local/tasks",
    ]);
  });

  test("a page's connection closing proves the same server again, without reading its version again", async () => {
    const server = await terminal({ version: "0.13.0" });
    const { backend, told } = follow();
    await backend.start();
    await vi.waitFor(() => expect(told).toEqual(["ready attached"]));
    expect(await (await backend.handle(app("/api/local/chats"))).json()).toEqual({
      pid: server.pid,
    });
    await vi.waitFor(() =>
      expect(told).toEqual(["ready attached", "holding attached", "ready attached"]),
    );
    await sleep(10 * KEEP_ALIVE_MS);
    expect(told).toHaveLength(3);
    expect(requests(home).map(({ path }) => path)).toEqual([
      "/api/local/status",
      "/api/local/chats",
    ]);
  });

  test("restarted from outside while no page connection was open, the next server's version is read once the page's next request meets it", async () => {
    const first = await terminal({ version: "0.13.0" });
    const { port } = JSON.parse(readFileSync(join(home, "locks", "4273f434b594.info"), "utf8"));
    const { backend, told, readies } = follow();
    await backend.start();
    await vi.waitFor(() => expect(told).toEqual(["ready attached"]));
    const exited = new Promise((done) => first.once("exit", done));
    await fetch(`http://127.0.0.1:${port}/api/local/restart`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(await exited).toBe(75);
    // Its connections stay open long after this test: no idle close comes to start a grace.
    const next = await terminal({ port, version: "0.14.0", keepAliveMs: 60_000 });
    // The page's next request finds the hint naming another process, which a grace period attaches
    // to: a new server, whose version is read.
    expect(await (await backend.handle(app("/api/local/chats"))).json()).toEqual({
      pid: next.pid,
    });
    await vi.waitFor(() => expect(backend.serverVersion).toBe("0.14.0"));
    expect(told).toEqual(["ready attached", "holding attached", "ready attached"]);
    expect(readies).toEqual([first.pid, next.pid]);
    expect(statusReads()).toEqual([first.pid, next.pid]);
  });
});

describe("our own backend", () => {
  test("the quit check asks it, and its restart is a new server whose version is read", async () => {
    const { backend, told } = follow({ FAKE_VERSION: "0.13.0", FAKE_KEEP_ALIVE_MS: "100" });
    expect(backend.quitCheck()).toBeNull();
    await backend.start();
    await vi.waitFor(() => expect(told).toEqual(["ready"]));
    expect(backend.serverVersion).toBe("0.13.0");
    expect(await backend.quitCheck()).toEqual({ calls: 0, tasks: 0, jobs: 0 });
    const restart = await backend.handle(app("/api/local/restart", { method: "POST" }));
    expect(restart.status).toBe(200);
    await vi.waitFor(() => expect(told).toEqual(["ready", "holding", "ready"]));
    const [first, second] = runs(home);
    // The version once per process, and the quit check's own.
    expect(statusReads()).toEqual([first?.pid, first?.pid, second?.pid]);
    await sleep(10 * KEEP_ALIVE_MS);
    expect(told).toHaveLength(3);
  });

  test("a ready the controller moved past while its version was read never reaches the window", async () => {
    const { backend, told, readies } = follow({ FAKE_STATUS_DELAY_MS: "800" });
    await backend.start();
    await vi.waitFor(() => expect(backend.state.phase).toBe("ready"));
    expect(told).toEqual([]);
    // Restarted while the first server's version is still being read.
    const restart = await backend.handle(app("/api/local/restart", { method: "POST" }));
    expect(restart.status).toBe(200);
    await vi.waitFor(() => expect(told).toEqual(["holding", "ready"]), { timeout: 5000 });
    expect(readies).toEqual([runs(home)[1]?.pid]);
    expect(backend.serverVersion).toBe("0.0.0-fake");
    await sleep(1000);
    expect(told).toEqual(["holding", "ready"]);
  });
});

test("the licenses are the payload's, packaged or staged beside the checkout", () => {
  const app = { execPath: "/x/Eidolon", resourcesPath: "/x/Resources", appPath: "/c/apps/desktop" };
  expect(licensesFile({ ...app, packaged: true })).toBe(
    "/x/Resources/eidolon/THIRD_PARTY_LICENSES.txt",
  );
  expect(licensesFile({ ...app, packaged: false })).toBe(
    `/c/apps/desktop/.stage/${process.platform}-${process.arch}/eidolon/THIRD_PARTY_LICENSES.txt`,
  );
});
