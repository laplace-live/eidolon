// Booting the local server: what it prints and when, the browser, the log level, the exits for
// a missing build, a bad token and a taken port, and stopping or restarting it.
import "../../../../packages/config/test/isolated-guard.ts";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  activePersona,
  consoleSink,
  dataHome,
  envOptional,
  jsRuntime,
  logger,
} from "@eidolon/config";
import { afterEach, describe, expect, test } from "vitest";
import { serveFetch } from "../../../../packages/config/test/http.ts";
import { bootLocal, shutdownOnce } from "../../src/local/boot.ts";
import { serverLockInfoPath, takeServerLock } from "../../src/local/server-lock.ts";
import { type LocalToken, tokenPath } from "../../src/local/token.ts";
import {
  type Booted,
  bootFixture,
  cleanUpBoot,
  type FakeIo,
  fakeIo,
  fakeModules,
  fixtureDist,
} from "./harness.ts";

const NO_OPEN = ["--host", "127.0.0.1", "--port", "0", "--no-open"];

const IPV6_LOOPBACK = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(false));
  probe.listen({ host: "::1", port: 0 }, () => probe.close(() => resolve(true)));
});

let booted: Booted | null = null;
const timeline: string[] = [];

/** All of `stream`, once it ends. */
async function text(stream: NodeJS.ReadableStream | null): Promise<string> {
  let all = "";
  for await (const chunk of stream ?? []) all += chunk;
  return all;
}

function recordLogs(): void {
  logger.setSink((record) => timeline.push(`log ${record.level} ${record.message}`));
}

/** A start with `argv` beside the booted server, which it leaves running. */
async function startAgain(argv: readonly string[]): Promise<FakeIo> {
  const io = fakeIo();
  const dist = fixtureDist();
  try {
    expect(await bootLocal(argv, fakeModules().modules, { dist, io })).toBeNull();
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
  return io;
}

/** The origin of the link a start that found the server printed, once its code checks out. */
function linkedOrigin(io: FakeIo, token: LocalToken): string | undefined {
  const link = /^Eidolon is already running: (http:\/\/[^/]+)\/#(\S+)\n$/.exec(io.out.join(""));
  expect(token.checkLinkCode(link?.[2], io.now)).toBe("ok");
  return link?.[1];
}

afterEach(async () => {
  await booted?.stop();
  booted = null;
  timeline.length = 0;
  logger.setSink(consoleSink);
  delete process.env.SSH_CONNECTION;
  cleanUpBoot();
});

describe("boot", () => {
  test("prints the link last, past the logger, and logs at INFO", async () => {
    recordLogs();
    const fakes = fakeModules();
    const io = fakeIo();
    io.stdout = (text) => {
      io.out.push(text);
      timeline.push(`stdout ${text}`);
    };
    const dist = fixtureDist();
    const server = await bootLocal(NO_OPEN, fakes.modules, { dist, io });
    booted = null;
    try {
      const port = server?.bot.server.port;
      expect(io.out).toHaveLength(1);
      expect(io.out[0]).toMatch(
        new RegExp(`^Eidolon is ready: http://127\\.0\\.0\\.1:${port}/#\\d+\\.[\\w-]{43}\\n$`),
      );
      expect(timeline.at(-1)).toBe(`stdout ${io.out[0]}`);
      expect(timeline.slice(0, -1).every((line) => line.startsWith("log "))).toBe(true);
      expect(timeline.some((line) => line.includes(`Bot server listening on`))).toBe(true);
      expect(fakes.levels).toEqual(["INFO"]);
      expect(io.err).toEqual([]);
      expect(io.opened).toEqual([]);
      expect(io.notified).toEqual([{ kind: "listening", port: port as number }]);
      expect(server?.url).toBe(io.out[0]?.slice("Eidolon is ready: ".length, -1));
    } finally {
      await server?.bot.stop();
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("opens the link unless --no-open, or over SSH", async () => {
    booted = await bootFixture({ argv: ["--host", "127.0.0.1", "--port", "0"] });
    expect(booted.io.opened).toEqual([booted.server.url]);
    await booted.stop();
    process.env.SSH_CONNECTION = "10.0.0.1 50000 10.0.0.2 22";
    booted = await bootFixture({ argv: ["--host", "127.0.0.1", "--port", "0", "--open"] });
    expect(booted.io.opened).toEqual([]);
  });

  test("-v logs at DEBUG and -vv at TRACE", async () => {
    booted = await bootFixture({ argv: [...NO_OPEN, "-v"] });
    expect(booted.fakes.levels).toEqual(["DEBUG"]);
    await booted.stop();
    booted = await bootFixture({ argv: [...NO_OPEN, "-vv"] });
    expect(booted.fakes.levels).toEqual(["TRACE"]);
  });

  test("keeps each persona's memories apart from the start", async () => {
    booted = await bootFixture();
    expect(envOptional("MEM0_AGENT_ID")).toBe(activePersona().id);
  });

  test("without a built app, exits 2 naming the build command, before making a token", async () => {
    const io = fakeIo();
    const empty = mkdtempSync(join(tmpdir(), "eidolon-dist-"));
    try {
      expect(await bootLocal(NO_OPEN, fakeModules().modules, { dist: empty, io })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(io.exits).toEqual([2]);
    expect(io.err.join("")).toContain("bun run build:web");
    expect(existsSync(tokenPath())).toBe(false);
  });

  test("with a token others can read, exits 1 saying so", async () => {
    booted = await bootFixture();
    await booted.stop();
    booted = null;
    chmodSync(tokenPath(), 0o644);
    const io = fakeIo();
    const dist = fixtureDist();
    try {
      expect(await bootLocal(NO_OPEN, fakeModules().modules, { dist, io })).toBeNull();
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
    expect(io.exits).toEqual([1]);
    expect(io.err.join("")).toContain("is readable by other users");
  });
});

describe("a port in use", () => {
  test("by this Eidolon: prints a fresh link to it and exits 0", async () => {
    booted = await bootFixture();
    const io = fakeIo();
    const dist = fixtureDist();
    try {
      const argv = ["--host", "127.0.0.1", "--port", String(booted.port), "--no-open"];
      expect(await bootLocal(argv, fakeModules().modules, { dist, io })).toBeNull();
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
    expect(io.exits).toEqual([0]);
    const link = /^Eidolon is already running: (http:\/\/127\.0\.0\.1:\d+\/)#(\S+)\n$/.exec(
      io.out.join(""),
    );
    expect(link?.[1]).toBe(`${booted.base}/`);
    expect(booted.token.checkLinkCode(link?.[2], io.now)).toBe("ok");
  });

  test("by this Eidolon on localhost: a start links to localhost, as the server did", async () => {
    booted = await bootFixture({ argv: ["--host", "localhost", "--port", "0", "--no-open"] });
    const [first] = await lookup("localhost", { all: true });
    const literal = first?.family === 6 ? `[${first.address}]` : first?.address;
    expect(JSON.parse(readFileSync(serverLockInfoPath(), "utf8"))).toMatchObject({
      port: booted.port,
      host: literal,
      linkHost: "localhost",
    });
    const io = await startAgain([
      "--host",
      "127.0.0.1",
      "--port",
      String(booted.port),
      "--no-open",
    ]);
    expect(io.exits).toEqual([0]);
    expect(linkedOrigin(io, booted.token)).toBe(`http://localhost:${booted.port}`);
  });

  test("by this Eidolon on 127.0.0.1 alone: a start on localhost links to 127.0.0.1", async () => {
    booted = await bootFixture();
    // A browser takes localhost to [::1] first, where another account could hold the port.
    const io = await startAgain(["--port", String(booted.port), "--no-open"]);
    expect(io.exits).toEqual([0]);
    expect(linkedOrigin(io, booted.token)).toBe(booted.base);
  });

  test.skipIf(!IPV6_LOOPBACK)(
    "by this Eidolon on [::1] alone: a start never asks 127.0.0.1, where a relay could prove it",
    async () => {
      booted = await bootFixture({ argv: ["--host", "::1", "--port", "0", "--no-open"] });
      const { port, token } = booted;
      let asked = 0;
      const relay = createServer((request, response) => {
        asked++;
        const nonce = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("probe");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ proof: token.probeProof(nonce ?? "") }));
      });
      await new Promise<void>((done) => relay.listen({ host: "127.0.0.1", port }, done));
      try {
        const io = await startAgain(["--port", String(port), "--no-open"]);
        expect(io.exits).toEqual([0]);
        expect(linkedOrigin(io, token)).toBe(`http://[::1]:${port}`);
        expect(asked).toBe(0);
      } finally {
        await new Promise((done) => relay.close(done));
      }
    },
  );

  test("no server can share the local port and take its requests", async () => {
    booted = await bootFixture();
    const port = booted.port;
    // With SO_REUSEPORT where Node can set it (Linux; macOS refuses it with ENOTSUP).
    const refused = await new Promise<string | undefined>((resolve) => {
      const other = createServer();
      other.once("error", (error: NodeJS.ErrnoException) => resolve(error.code));
      other.listen({ host: "127.0.0.1", port, reusePort: process.platform === "linux" }, () => {
        other.close();
        resolve(undefined);
      });
    });
    expect(refused).toBe("EADDRINUSE");
  });

  test("by another program: exits 1", async () => {
    const other = await serveFetch(() => new Response("hi"));
    const io = fakeIo();
    const dist = fixtureDist();
    try {
      const argv = ["--host", "127.0.0.1", "--port", String(other.port), "--no-open"];
      expect(await bootLocal(argv, fakeModules().modules, { dist, io })).toBeNull();
    } finally {
      await other.stop();
      rmSync(dist, { recursive: true, force: true });
    }
    expect(io.exits).toEqual([1]);
    expect(io.err.join("")).toContain("taken by another program");
    expect(io.out).toEqual([]);
    // The boot that gave up holds nothing.
    const lock = takeServerLock();
    expect("release" in lock).toBe(true);
    if ("release" in lock) lock.release();
  });
});

describe("one server per data home", () => {
  test("a second, on another port, exits 2 naming the first's pid and port", async () => {
    booted = await bootFixture();
    const io = fakeIo();
    const dist = fixtureDist();
    try {
      expect(await bootLocal(NO_OPEN, fakeModules().modules, { dist, io })).toBeNull();
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
    expect(io.exits).toEqual([2]);
    expect(io.err.join("")).toBe(
      `eidolon: Eidolon is already running on this data home (pid ${process.pid}, port ` +
        `${booted.port}); stop it first\n`,
    );
    expect(io.out).toEqual([]);
    expect((await fetch(`${booted.base}/`)).status).toBe(200);
  });

  test("a second on the port of an older first, which records no host, exits 2 too", async () => {
    booted = await bootFixture();
    const {
      host: _host,
      linkHost: _linkHost,
      ...older
    } = JSON.parse(readFileSync(serverLockInfoPath(), "utf8"));
    writeFileSync(serverLockInfoPath(), JSON.stringify(older));
    const io = await startAgain(["--port", String(booted.port), "--no-open"]);
    expect(io.exits).toEqual([2]);
    expect(io.err.join("")).toBe(
      `eidolon: Eidolon is already running on this data home (pid ${process.pid}, port ` +
        `${booted.port}); stop it first\n`,
    );
    expect(io.out).toEqual([]);
  });

  test("the first holds the lock until it stops; then another starts", async () => {
    booted = await bootFixture();
    expect(JSON.parse(readFileSync(serverLockInfoPath(), "utf8"))).toMatchObject({
      pid: process.pid,
      port: booted.port,
      host: "127.0.0.1",
      linkHost: "127.0.0.1",
      command: "eidolon",
    });
    expect("holder" in takeServerLock()).toBe(true);
    await booted.stop();
    booted = await bootFixture();
    expect(booted.io.exits).toEqual([]);
  });

  test.skipIf(!IPV6_LOOPBACK)(
    "one bound to ::1 alone records that host, as a URL names it",
    async () => {
      booted = await bootFixture({ argv: ["--host", "::1", "--port", "0", "--no-open"] });
      expect(JSON.parse(readFileSync(serverLockInfoPath(), "utf8"))).toMatchObject({
        port: booted.port,
        host: "[::1]",
        linkHost: "[::1]",
      });
    },
  );
});

describe("stopping", () => {
  test("a signal stops the server, then exits 0", async () => {
    booted = await bootFixture();
    booted.io.shutdown?.();
    for (let waited = 0; booted.io.exits.length === 0 && waited < 2000; waited += 10) {
      await delay(10);
    }
    expect(booted.io.exits).toEqual([0]);
    const refused = await fetch(`${booted.base}/`).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
  });

  test("restart stops the server shortly after, then exits 75", async () => {
    booted = await bootFixture();
    booted.server.restart();
    expect(booted.io.exits).toEqual([]);
    for (let waited = 0; booted.io.exits.length === 0 && waited < 3000; waited += 20) {
      await delay(20);
    }
    expect(booted.io.exits).toEqual([75]);
  });

  test("a supervisor gone before the server listened for it still stops it, and is told nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-boot-channel-"));
    try {
      const script = join(dir, "server.mjs");
      const boot = pathToFileURL(join(import.meta.dirname, "../../src/local/boot.ts")).href;
      writeFileSync(
        script,
        `const { processIo } = await import(${JSON.stringify(boot)});
// As a boot can: the channel closes while the server still starts.
while (process.connected) await new Promise((done) => setTimeout(done, 10));
processIo.onShutdown(() => process.stdout.write("shutdown\\n"));
processIo.notify({ kind: "listening", port: 1 });
setTimeout(() => process.exit(0), 200);
`,
      );
      const child = spawn(process.execPath, [...jsRuntime().args, script], {
        env: {
          ...jsRuntime().env,
          PATH: process.env.PATH ?? "",
          EIDOLON_HOME: dataHome(),
          EIDOLON_NO_DOTENV: "1",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      child.disconnect();
      // Node emits no close for a child whose channel the parent closed first.
      const exited = new Promise((done) => child.on("exit", done));
      const [out, err] = await Promise.all([text(child.stdout), text(child.stderr)]);
      expect([await exited, out, err]).toEqual([0, "shutdown\n", ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shutdownOnce: a repeat within half a second is the same Ctrl-C; a later one exits now", async () => {
    const exits: number[] = [];
    let stops = 0;
    let now = 0;
    const shutdown = shutdownOnce(
      {
        stop: () => {
          stops++;
          return new Promise(() => {});
        },
      },
      (code) => exits.push(code),
      () => now,
    );
    shutdown(0);
    now = 100;
    shutdown(0);
    expect([stops, exits]).toEqual([1, []]);
    now = 700;
    shutdown(0);
    expect([stops, exits]).toEqual([1, [0]]);
  });

  test("shutdownOnce exits with its code once the stop settles, failed or not", async () => {
    const exits: number[] = [];
    shutdownOnce({ stop: async () => Promise.reject(new Error("hung up")) }, (code) =>
      exits.push(code),
    )(75);
    logger.setSink(() => {});
    await delay(0);
    await delay(0);
    expect(exits).toEqual([75]);
  });
});
