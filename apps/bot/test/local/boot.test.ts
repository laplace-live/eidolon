// Booting the local server: what it prints and when, the browser, the log level, the exits for
// a missing build, a bad token and a taken port, and stopping or restarting it.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activePersona, consoleSink, envOptional, logger } from "@eidolon/config";
import { bootLocal, shutdownOnce } from "../../src/local/boot.ts";
import { serverLockInfoPath, takeServerLock } from "../../src/local/server-lock.ts";
import { tokenPath } from "../../src/local/token.ts";
import {
  type Booted,
  bootFixture,
  cleanUpBoot,
  fakeIo,
  fakeModules,
  fixtureDist,
} from "./harness.ts";

const NO_OPEN = ["--host", "127.0.0.1", "--port", "0", "--no-open"];

let booted: Booted | null = null;
const timeline: string[] = [];

function recordLogs(): void {
  logger.setSink((record) => timeline.push(`log ${record.level} ${record.message}`));
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

  test("no server can share the local port and take its requests", async () => {
    booted = await bootFixture();
    const port = booted.port;
    const share = () =>
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        development: false,
        fetch: () => new Response("x"),
      });
    expect(share).toThrow(expect.objectContaining({ code: "EADDRINUSE" }));
  });

  test("by another program: exits 1", async () => {
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hi") });
    const io = fakeIo();
    const dist = fixtureDist();
    try {
      const argv = ["--host", "127.0.0.1", "--port", String(other.port), "--no-open"];
      expect(await bootLocal(argv, fakeModules().modules, { dist, io })).toBeNull();
    } finally {
      other.stop(true);
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

  test("the first holds the lock until it stops; then another starts", async () => {
    booted = await bootFixture();
    expect(JSON.parse(readFileSync(serverLockInfoPath(), "utf8"))).toMatchObject({
      pid: process.pid,
      port: booted.port,
      command: "eidolon",
    });
    expect("holder" in takeServerLock()).toBe(true);
    await booted.stop();
    booted = await bootFixture();
    expect(booted.io.exits).toEqual([]);
  });
});

describe("stopping", () => {
  test("a signal stops the server, then exits 0", async () => {
    booted = await bootFixture();
    booted.io.shutdown?.();
    for (let waited = 0; booted.io.exits.length === 0 && waited < 2000; waited += 10) {
      await Bun.sleep(10);
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
      await Bun.sleep(20);
    }
    expect(booted.io.exits).toEqual([75]);
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
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(exits).toEqual([75]);
  });
});
