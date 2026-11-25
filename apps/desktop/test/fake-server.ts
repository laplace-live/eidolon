// A plain script that answers as the local server does (IPC listening, probe proofs, the Bearer,
// status with a version, exit 75 on restart, a stop on the channel's close), on a temporary data
// home, and a terminal's server started from it the way `pnpm app` runs one.
import "../../../packages/config/test/isolated-guard.ts";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
const version = process.env.FAKE_VERSION ?? "0.0.0-fake";
const statusDelay = Number(process.env.FAKE_STATUS_DELAY_MS ?? 0);
const json = (response, body) =>
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://x");
  if (url.pathname === "/api/local/session" && url.searchParams.has("probe")) {
    response.end(JSON.stringify({ proof: sign("probe:" + url.searchParams.get("probe")) }));
    return;
  }
  if (request.headers.authorization !== "Bearer " + secret) {
    response.writeHead(401).end();
    return;
  }
  appendFileSync(join(home, "requests.ndjson"), JSON.stringify({
    pid: process.pid,
    method: request.method,
    path: url.pathname,
  }) + "\\n");
  if (request.method === "POST" && url.pathname === "/api/local/restart") {
    json(response, { ok: true });
    setTimeout(() => stop(75), 100);
  } else if (url.pathname === "/api/local/status") {
    const answer = () => json(response, { pid: process.pid, version, activeCalls: 0, assistant: { running: 0 } });
    if (statusDelay > 0) setTimeout(answer, statusDelay);
    else answer();
  } else if (url.pathname === "/api/local/jobs") {
    json(response, []);
  } else {
    json(response, { pid: process.pid });
  }
});
function stop(code) {
  server.close();
  server.closeAllConnections();
  rmSync(info, { force: true });
  process.exit(code);
}
if (process.env.FAKE_KEEP_ALIVE_MS) server.keepAliveTimeout = Number(process.env.FAKE_KEEP_ALIVE_MS);
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

/** Writes the fake server to `path`, as an ES module whatever its name. */
export function writeFakeServer(path: string): void {
  writeFileSync(path, FAKE_SERVER);
  writeFileSync(join(path, "..", "package.json"), '{ "type": "module" }\n');
}

/** A data home holding `secret` as its local-token. */
export function makeHome(home: string, secret: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "local-token"), `${secret}\n`, { mode: 0o600 });
}

/** What a test's backend runs with: no developer keys, and every Eidolon folder a temporary one. */
export function environment(dir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    EIDOLON_REAL_HOME: join(dir, "real-home"),
    EIDOLON_SHARED_SKILLS: join(dir, "shared-skills"),
  };
}

/** Each start of the fake on `home`: its pid, flags, argv, folder and Eidolon variables. */
export function runs(
  home: string,
): { pid: number; execArgv: string[]; argv: string[]; cwd: string; env: object }[] {
  return readFileSync(join(home, "runs.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** Each request the fakes on `home` took with the Bearer, the probes left out. */
export function requests(home: string): { pid: number; method: string; path: string }[] {
  let text: string;
  try {
    text = readFileSync(join(home, "requests.ndjson"), "utf8");
  } catch {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

export interface TerminalServerOptions {
  readonly script: string;
  readonly home: string;
  /** The folder environment() names its Eidolon folders in. */
  readonly dir: string;
  readonly port: number;
  /** How long an idle connection stays open; Node's 5 s unless given. */
  readonly keepAliveMs?: number;
  readonly version?: string;
}

/**
 * A terminal's server on the data home, as `pnpm app` runs it, which records where it listens.
 * `cleanups` gets what stops it.
 */
export function terminalServer(
  options: TerminalServerOptions,
  cleanups: (() => Promise<void> | void)[],
): Promise<ChildProcess> {
  const { script, home, dir, port, keepAliveMs, version } = options;
  const child = spawn(
    process.execPath,
    [script, "--host", "127.0.0.1", "--port", String(port), "--no-open"],
    {
      env: {
        ...environment(dir),
        EIDOLON_HOME: home,
        FAKE_RECORDS_INFO: "1",
        ...(keepAliveMs === undefined ? {} : { FAKE_KEEP_ALIVE_MS: String(keepAliveMs) }),
        ...(version === undefined ? {} : { FAKE_VERSION: version }),
      },
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
