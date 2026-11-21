import "../../../packages/config/test/isolated-guard.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect } from "node:util";
import { dataHome as configDataHome } from "@eidolon/config";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { recordServerPort, takeServerLock } from "../../bot/src/local/server-lock.ts";
import { LocalToken } from "../../bot/src/local/token.ts";
import {
  BearerToken,
  dataHome,
  hintFrom,
  isAlive,
  originOf,
  probe,
  probeNonce,
  probeProof,
  readServerInfo,
  readToken,
  SERVER_INFO,
} from "../src/main/attach.ts";

const SECRET = "s".repeat(43);

const IPV6_LOOPBACK = await new Promise<boolean>((done) => {
  const server = createServer();
  server.once("error", () => done(false));
  server.listen({ host: "::1", port: 0 }, () => server.close(() => done(true)));
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "eidolon-desktop-attach-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeInfo(value: unknown): void {
  mkdirSync(join(home, "locks"), { recursive: true });
  writeFileSync(join(home, SERVER_INFO), typeof value === "string" ? value : JSON.stringify(value));
}

describe("the hint", () => {
  test("is the server lock's .info, named by SHA-256 of local-server", () => {
    const stem = createHash("sha256").update("local-server").digest("hex").slice(0, 12);
    expect(SERVER_INFO).toBe(join("locks", `${stem}.info`));
  });

  test("reads what the server lock writes once a server listens", () => {
    const realHome = configDataHome();
    const lock = takeServerLock();
    if (!("release" in lock)) throw new Error("the lock is held already");
    try {
      expect(hintFrom(readServerInfo(realHome))).toBeNull();
      recordServerPort(54321, "127.0.0.1", "127.0.0.1");
      expect(hintFrom(readServerInfo(realHome))).toEqual({
        pid: process.pid,
        port: 54321,
        host: "127.0.0.1",
      });
      recordServerPort(54322, "[::1]", "localhost");
      expect(hintFrom(readServerInfo(realHome))).toEqual({
        pid: process.pid,
        port: 54322,
        host: "[::1]",
      });
    } finally {
      lock.release();
      rmSync(realHome, { recursive: true, force: true });
    }
  });

  test("is no hint while the .info is missing, half written, or not an object", () => {
    expect(readServerInfo(home)).toBeNull();
    writeInfo('{"pid": 4242, "comm');
    expect(readServerInfo(home)).toBeNull();
    writeInfo([4242, 7860]);
    expect(readServerInfo(home)).toBeNull();
  });

  test("an older server's .info, with no host, names its holder but is never probed", () => {
    writeInfo({ pid: 4242, command: "eidolon", key: "local-server", start: "x", port: 7860 });
    expect(readServerInfo(home)).toEqual({ pid: 4242, port: 7860, host: null });
    expect(hintFrom(readServerInfo(home))).toBeNull();
  });

  test("takes only a loopback address as a URL names it, and a real port and pid", () => {
    for (const host of ["127.0.0.1", "127.8.9.10", "[::1]"]) {
      writeInfo({ pid: 4242, port: 7860, host });
      expect(hintFrom(readServerInfo(home))).toEqual({ pid: 4242, port: 7860, host });
    }
    for (const host of [
      "::1",
      "localhost",
      "0.0.0.0",
      "192.168.1.2",
      "127.0.0.01",
      "127.0.0.256",
      "evil.example",
    ]) {
      writeInfo({ pid: 4242, port: 7860, host });
      expect([host, readServerInfo(home)?.host]).toEqual([host, null]);
    }
    for (const port of [0, 65536, 78.6, "7860"]) {
      writeInfo({ pid: 4242, port, host: "127.0.0.1" });
      expect(hintFrom(readServerInfo(home))).toBeNull();
    }
    for (const pid of [0, -1, 1.5, "4242"]) {
      writeInfo({ pid, port: 7860, host: "127.0.0.1" });
      expect(hintFrom(readServerInfo(home))).toBeNull();
    }
  });

  test("names the origin to probe", () => {
    expect(originOf({ host: "127.0.0.1", port: 7860 })).toBe("http://127.0.0.1:7860");
    expect(originOf({ host: "[::1]", port: 7861 })).toBe("http://[::1]:7861");
  });
});

describe("local-token", () => {
  test("is read as the server reads it, trimmed, and nothing else is a token", () => {
    expect(readToken(home)).toBeNull();
    writeFileSync(join(home, "local-token"), `${SECRET}\n`);
    expect(readToken(home)?.secret).toBe(SECRET);
    writeFileSync(join(home, "local-token"), "short\n");
    expect(readToken(home)).toBeNull();
    rmSync(join(home, "local-token"));
    writeFileSync(join(home, "elsewhere"), `${SECRET}\n`);
    symlinkSync(join(home, "elsewhere"), join(home, "local-token"));
    expect(readToken(home)).toBeNull();
  });

  test("never prints its secret", () => {
    const token = new BearerToken(SECRET);
    expect(inspect(token)).not.toContain(SECRET);
    expect(inspect({ phase: "ready", token }, { depth: 5 })).not.toContain(SECRET);
    expect(JSON.stringify({ token })).not.toContain(SECRET);
    expect(String(token)).not.toContain(SECRET);
  });
});

describe("liveness", () => {
  test("this process runs, and one that exited doesn't", async () => {
    expect(isAlive(process.pid)).toBe(true);
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid as number;
    await new Promise((done) => child.on("exit", done));
    expect(isAlive(pid)).toBe(false);
  });
});

interface SeenProbe {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

/** A server that answers probes as session.ts does, holding `secret`. */
async function prover(
  secret: string,
  answer?: (nonce: string) => { status: number; body: string } | null,
): Promise<{ server: Server; origin: string; seen: SeenProbe[] }> {
  const local = new LocalToken(secret);
  const seen: SeenProbe[] = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    const nonce = new URL(request.url ?? "/", "http://x").searchParams.get("probe") ?? "";
    const custom = answer?.(nonce);
    if (custom === null) return; // never answers
    const { status, body } = custom ?? {
      status: 200,
      body: JSON.stringify({ proof: local.probeProof(nonce) }),
    };
    response.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  await new Promise<void>((done) => server.listen({ host: "127.0.0.1", port: 0 }, done));
  const { port } = server.address() as { port: number };
  return { server, origin: `http://127.0.0.1:${port}`, seen };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}

describe("the probe", () => {
  test("signs as the server's token.ts does", () => {
    const nonce = probeNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(probeProof(new BearerToken(SECRET), nonce)).toBe(
      new LocalToken(SECRET).probeProof(nonce),
    );
  });

  test("proves a server that holds the token, sending neither the token nor a credential", async () => {
    const { server, origin, seen } = await prover(SECRET);
    try {
      expect(await probe(origin, new BearerToken(SECRET))).toBe(true);
      expect(seen).toHaveLength(1);
      const [first] = seen;
      expect(first?.url).toMatch(/^\/api\/local\/session\?probe=[A-Za-z0-9_-]{16,64}$/);
      expect(first?.headers.authorization).toBeUndefined();
      expect(first?.headers.cookie).toBeUndefined();
      expect(JSON.stringify(first)).not.toContain(SECRET);
      // Its own connection, closed after: never one of the forwarder's.
      expect(first?.headers.connection).toBe("close");
    } finally {
      await close(server);
    }
  });

  test("refuses a server holding another token, a wrong answer, and nothing listening", async () => {
    const other = await prover("o".repeat(43));
    const wrong = await prover(SECRET, () => ({ status: 200, body: '{"proof":"nope"}' }));
    // A proof, but in an error: only a 200 counts, as boot.ts's own probe has it.
    const failing = await prover(SECRET, (nonce) => ({
      status: 500,
      body: JSON.stringify({ proof: new LocalToken(SECRET).probeProof(nonce) }),
    }));
    const garbled = await prover(SECRET, () => ({ status: 200, body: "<html>" }));
    try {
      const token = new BearerToken(SECRET);
      expect(await probe(other.origin, token)).toBe(false);
      expect(await probe(wrong.origin, token)).toBe(false);
      expect(await probe(failing.origin, token)).toBe(false);
      expect(await probe(garbled.origin, token)).toBe(false);
    } finally {
      for (const { server } of [other, wrong, failing, garbled]) await close(server);
    }
    expect(await probe(other.origin, new BearerToken(SECRET))).toBe(false);
  });

  test("gives up on a server that doesn't answer by its deadline", async () => {
    const { server, origin } = await prover(SECRET, () => null);
    try {
      const started = performance.now();
      expect(await probe(origin, new BearerToken(SECRET), 300)).toBe(false);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      await close(server);
    }
  });

  test.skipIf(!IPV6_LOOPBACK)("reaches a server that bound ::1 alone", async () => {
    const local = new LocalToken(SECRET);
    const server = createServer((request, response) => {
      const nonce = new URL(request.url ?? "/", "http://x").searchParams.get("probe") ?? "";
      response.end(JSON.stringify({ proof: local.probeProof(nonce) }));
    });
    await new Promise<void>((done) => server.listen({ host: "::1", port: 0 }, done));
    try {
      const { port } = server.address() as { port: number };
      expect(await probe(originOf({ host: "[::1]", port }), new BearerToken(SECRET))).toBe(true);
    } finally {
      await close(server);
    }
  });
});

describe("the data home", () => {
  test("is EIDOLON_HOME as the backend reads it, or ~/.laplace/eidolon", () => {
    expect(dataHome({}, "darwin")).toBe(join(homedir(), ".laplace", "eidolon"));
    expect(dataHome({ EIDOLON_HOME: "" }, "darwin")).toBe(join(homedir(), ".laplace", "eidolon"));
    expect(dataHome({ EIDOLON_HOME: "/tmp/somewhere" }, "darwin")).toBe(resolve("/tmp/somewhere"));
    expect(dataHome({ EIDOLON_HOME: "~/eidolon" }, "darwin")).toBe(join(homedir(), "eidolon"));
    expect(dataHome({ EIDOLON_HOME: "~" }, "darwin")).toBe(homedir());
    expect(dataHome({ EIDOLON_HOME: "relative" }, "darwin")).toBe(resolve("relative"));
  });

  test("matches the backend's own dataHome() for the same environment", () => {
    const saved = process.env.EIDOLON_HOME as string;
    try {
      for (const value of [saved, "~/elsewhere", "relative/home", "/abs/home", ""]) {
        process.env.EIDOLON_HOME = value;
        expect([value, dataHome(process.env)]).toEqual([value, configDataHome()]);
      }
      delete process.env.EIDOLON_HOME;
      expect(dataHome(process.env)).toBe(configDataHome());
    } finally {
      process.env.EIDOLON_HOME = saved;
    }
  });

  test("on Windows, whose names have no case, in any case", () => {
    expect(dataHome({ Eidolon_Home: "C:\\Users\\me\\eidolon" }, "win32")).toBe(
      resolve("C:\\Users\\me\\eidolon"),
    );
    expect(dataHome({ Eidolon_Home: "/elsewhere" }, "darwin")).toBe(
      join(homedir(), ".laplace", "eidolon"),
    );
  });
});
