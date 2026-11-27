import "../../../packages/config/test/isolated-guard.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dataHome } from "@eidolon/config";
import { lockInfoPath } from "@eidolon/config/lock";
import { SubspaceStore } from "@eidolon/subspace";
import { afterEach, describe, expect, test, vi } from "vitest";
import { pairMain, startHeadlessServer } from "../src/pair.ts";
import { probeRunningLocalServer, subspaceMain } from "../src/subspace.ts";
import { captureIo } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("laplace-pair and laplace-subspace", () => {
  test("--help shows CLI usage", async () => {
    const pairHelp = captureIo();
    expect(await pairMain(["--help"], pairHelp.io)).toBe(0);
    expect(pairHelp.stdout()).toContain("usage: laplace-pair");
    expect(pairHelp.stdout()).toContain("--relay");

    const subHelp = captureIo();
    expect(await subspaceMain(["--help"], subHelp.io)).toBe(0);
    expect(subHelp.stdout()).toContain("usage: laplace-subspace");
    expect(subHelp.stdout()).toContain("revoke");
  });

  test("pair validates --port range", async () => {
    const io = captureIo();
    expect(await pairMain(["--port", "70000"], io.io)).toBe(2);
    expect(io.stderr()).toContain("must be between 0 and 65535");
  });

  test("pair --no-wait exits 2 when no local server is running", async () => {
    const io = captureIo();
    expect(await pairMain(["--no-wait"], io.io)).toBe(2);
    expect(io.stderr()).toContain("--no-wait requires an already-running Eidolon server");
  });

  test("subspace status, grants, and revoke read/modify subspace store cleanly", async () => {
    const store = new SubspaceStore(dataHome());
    store.addGrant({
      id: "grant_cli_1",
      clientName: "CLI Test Phone",
      tokenSha256: "a".repeat(64),
      mode: "direct",
      createdAt: 1_760_000_000_000,
      lastSeenAt: null,
    });

    const statusIo = captureIo();
    expect(await subspaceMain(["status", "--json"], statusIo.io)).toBe(0);
    const status = JSON.parse(statusIo.stdout()) as {
      running: boolean;
      share: { grants: readonly { id: string }[] };
    };
    expect(status.running).toBe(false);
    expect(status.share.grants.map((g) => g.id)).toEqual(["grant_cli_1"]);

    const grantsIo = captureIo();
    expect(await subspaceMain(["grants", "--json"], grantsIo.io)).toBe(0);
    const grants = JSON.parse(grantsIo.stdout()) as Record<string, unknown>[];
    expect(grants).toEqual([
      {
        id: "grant_cli_1",
        clientName: "CLI Test Phone",
        mode: "direct",
        createdAt: 1_760_000_000_000,
        lastSeenAt: null,
      },
    ]);
    expect(grantsIo.stdout()).not.toContain("tokenSha256");
    expect(grantsIo.stdout()).not.toContain("relayTokenSha256");

    const revokeIo = captureIo();
    expect(await subspaceMain(["revoke", "grant_cli_1", "--json"], revokeIo.io)).toBe(0);
    expect(JSON.parse(revokeIo.stdout())).toEqual({ revoked: "grant_cli_1" });
    expect(store.readGrants()).toEqual([]);

    const missingRevoke = captureIo();
    expect(await subspaceMain(["revoke", "nonexistent"], missingRevoke.io)).toBe(1);
    expect(missingRevoke.stderr()).toContain("Unknown grant id");
  });

  test("subspace logout resets offline relay shareMode to off and probeRunningLocalServer refuses unverified listeners", async () => {
    const store = new SubspaceStore(dataHome());
    const identity = await store.loadOrCreateIdentity();
    store.saveIdentity({ ...identity, shareMode: "relay" });

    const logoutIo = captureIo();
    expect(await subspaceMain(["logout", "--json"], logoutIo.io)).toBe(0);
    expect(JSON.parse(logoutIo.stdout())).toEqual({ status: "signed-out" });
    expect((await store.loadOrCreateIdentity()).shareMode).toBe("off");

    // Corrupt relay-auth.json must still allow status and explicit logout offline.
    writeFileSync(join(store.dir, "relay-auth.json"), "{corrupt-json", "utf8");
    const corruptStatusIo = captureIo();
    expect(await subspaceMain(["status", "--json"], corruptStatusIo.io)).toBe(0);
    expect(JSON.parse(corruptStatusIo.stdout())).toMatchObject({
      relayAuth: { status: "signed-out", user: null },
    });
    const corruptLogoutIo = captureIo();
    expect(await subspaceMain(["logout", "--json"], corruptLogoutIo.io)).toBe(0);
    expect(JSON.parse(corruptLogoutIo.stdout())).toEqual({ status: "signed-out" });
    expect(corruptLogoutIo.stderr()).toContain("corrupted");
    expect(store.readRelayAuth()).toBeNull();

    // Partially corrupt relay-auth.json with valid authUrl + token still revokes the remote session.
    const signOutFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    writeFileSync(
      join(store.dir, "relay-auth.json"),
      JSON.stringify({ authUrl: "http://127.0.0.1:4321/", token: "recover-tok", user: "bad" }),
      "utf8",
    );
    const partialLogoutIo = captureIo();
    expect(await subspaceMain(["logout", "--json"], partialLogoutIo.io)).toBe(0);
    expect(partialLogoutIo.stderr()).toBe("");
    expect(signOutFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/api/auth/sign-out",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer recover-tok" }),
      }),
    );
    expect(store.readRelayAuth()).toBeNull();

    // Schema-valid relay-auth.json with a disallowed plaintext non-loopback authUrl must skip
    // remote sign-out, warn clearly, and wipe the local file.
    signOutFetch.mockClear();
    store.saveRelayAuth({
      authUrl: "http://evil.example.com",
      relayUrl: "https://eidolon-relay.vrp.moe",
      token: "plaintext-secret",
      user: { id: "u1", name: "User", email: "user@example.com", image: null },
      savedAt: Date.now(),
    });
    const disallowedLogoutIo = captureIo();
    expect(await subspaceMain(["logout", "--json"], disallowedLogoutIo.io)).toBe(0);
    expect(signOutFetch).not.toHaveBeenCalled();
    expect(disallowedLogoutIo.stderr()).toContain("disallowed auth URL");
    expect(store.readRelayAuth()).toBeNull();

    // Non-loopback plaintext relay/auth URLs must be rejected before talking to any server.
    const badRelayIo = captureIo();
    expect(
      await subspaceMain(["login", "--relay-url", "http://relay.example.com"], badRelayIo.io),
    ).toBe(2);
    expect(badRelayIo.stderr()).toContain("https/wss or loopback");

    // A non-Eidolon server listening on the port from local-server.info must not receive Bearer token.
    const seenHeaders: (string | undefined)[] = [];
    const decoy = createServer((req, res) => {
      seenHeaders.push(req.headers.authorization);
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => decoy.listen(0, "127.0.0.1", resolve));
    try {
      const addr = decoy.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const infoPath = lockInfoPath("local-server");
      mkdirSync(join(dataHome(), "locks"), { recursive: true });
      writeFileSync(infoPath, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port }));
      writeFileSync(join(dataHome(), "local-token"), "a".repeat(43));

      expect(await probeRunningLocalServer()).toBeNull();
      expect(seenHeaders).toEqual([undefined]);
    } finally {
      await new Promise<void>((resolve) => decoy.close(() => resolve()));
    }
  });

  test("startHeadlessServer drains stderr before throwing on non-zero exit and ignores stdout flood", async () => {
    const work = mkdtempSync(join(tmpdir(), "pair-stderr-"));
    try {
      const entry = join(work, "fail-server.mjs");
      writeFileSync(
        entry,
        [
          'process.stdout.write("x".repeat(256 * 1024));',
          'process.stderr.write("fatal boot failure");',
          "setTimeout(() => { process.stderr.write(' tail\\n'); process.exit(1); }, 15);",
        ].join("\n"),
      );
      await expect(startHeadlessServer(undefined, { entry })).rejects.toThrow(
        "Server exited with status 1: fatal boot failure tail",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("pairMain respawns headless server on exit 75 with bound port and re-probes to print new grants", async () => {
    const work = mkdtempSync(join(tmpdir(), "pair-restart-"));
    const argsLog = join(work, "args.log");
    const firstPortFile = join(work, "first-port.txt");
    const entry = join(work, "fake-server.mjs");
    const infoPath = lockInfoPath("local-server");
    const tokenPath = join(dataHome(), "local-token");
    writeFileSync(
      entry,
      `
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n");
const portFlag = args.find((a) => a.startsWith("--port="));
const requestedPort = portFlag ? Number(portFlag.slice("--port=".length)) : 0;
const isSecondBoot = requestedPort > 0;
const token = isSecondBoot ? "b".repeat(43) : "a".repeat(43);

const grants = isSecondBoot
  ? [{ id: "g_after_reboot", clientName: "Reboot Phone", mode: "direct", createdAt: 2, lastSeenAt: null }]
  : [];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/local/session") {
    const nonce = url.searchParams.get("probe") ?? "";
    const proof = createHmac("sha256", token).update("probe:" + nonce, "utf8").digest("base64url");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ proof }));
    return;
  }
  if (url.pathname === "/api/local/subspace" && req.method === "GET") {
    if (req.headers.authorization !== "Bearer " + token) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      activeHostId: null,
      servers: [],
      share: { hostName: "Headless", shareMode: "direct", directPort: 45123, directAddress: null, addresses: [], listening: true, listeningPort: 45123, relayConnected: false, relayError: null, activeOffer: null, grants },
      relayAuth: { authUrl: "https://id.laplace.live", relayUrl: "https://eidolon-relay.vrp.moe", status: "signed-out", user: null, deviceFlow: { status: "idle", userCode: null, verificationUri: null, verificationUriComplete: null, expiresAt: null, error: null } },
    }));
    return;
  }
  if (url.pathname === "/api/local/subspace/share/offer" && req.method === "POST") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      pairingUrl: "eidolon://pair?code=123",
      pairingCode: "123",
      qrSvg: "<svg/>",
      expiresAt: Date.now() + 60_000,
      state: {
        activeHostId: null,
        servers: [],
        share: { hostName: "Headless", shareMode: "direct", directPort: 45123, directAddress: null, addresses: [], listening: true, listeningPort: 45123, relayConnected: false, relayError: null, activeOffer: null, grants: [] },
        relayAuth: { authUrl: "https://id.laplace.live", relayUrl: "https://eidolon-relay.vrp.moe", status: "signed-out", user: null, deviceFlow: { status: "idle", userCode: null, verificationUri: null, verificationUriComplete: null, expiresAt: null, error: null } },
      },
    }));
    setTimeout(() => {
      server.closeAllConnections();
      server.close(() => process.exit(75));
    }, 50);
    return;
  }
  res.writeHead(404).end();
});

const listenPort = isSecondBoot ? 0 : requestedPort;
server.listen(listenPort, "127.0.0.1", () => {
  const port = server.address().port;
  if (!isSecondBoot) writeFileSync(${JSON.stringify(firstPortFile)}, String(port));
  mkdirSync(${JSON.stringify(dirname(infoPath))}, { recursive: true });
  writeFileSync(${JSON.stringify(tokenPath)}, token);
  writeFileSync(${JSON.stringify(infoPath)}, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port }));
  process.send?.({ kind: "listening", port });
});
`,
    );
    const controller = new AbortController();
    const io = captureIo();
    try {
      const exitPromise = pairMain(["--json"], {
        ...io.io,
        signal: controller.signal,
        serverEntry: entry,
        pollMs: 50,
      });
      await expect.poll(() => io.stdout(), { timeout: 10_000 }).toContain('"id":"g_after_reboot"');
      controller.abort();
      expect(await exitPromise).toBe(0);
      const spawns = readFileSync(argsLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(spawns).toHaveLength(2);
      expect(spawns[0]).toContain("--port=0");
      const secondPortArg = spawns[1]?.find((arg) => arg.startsWith("--port="));
      expect(secondPortArg).toBeDefined();
      const firstPort = Number(readFileSync(firstPortFile, "utf8"));
      expect(firstPort).toBeGreaterThan(0);
      expect(Number(secondPortArg?.slice("--port=".length))).toBe(firstPort);
    } finally {
      controller.abort();
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("pair --wait exits with stderr error when spawned headless server terminates unexpectedly, and subspace rejects ws auth URLs", async () => {
    const authIo = captureIo();
    expect(await subspaceMain(["login", "--auth-url", "wss://id.example.com"], authIo.io)).toBe(2);
    expect(authIo.stderr()).toContain("must use https or loopback http");

    const work = mkdtempSync(join(tmpdir(), "eidolon-pair-die-"));
    const entry = join(work, "die-server.mjs");
    const infoPath = lockInfoPath("local-server");
    const tokenPath = join(dataHome(), "local-token");
    writeFileSync(
      entry,
      `
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

const token = "die-test-token-0123456789abcdef";
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/local/session") {
    const probe = url.searchParams.get("probe") ?? "";
    const proof = createHmac("sha256", token).update("probe:" + probe, "utf8").digest("base64url");
    res.writeHead(200).end(JSON.stringify({ proof }));
    return;
  }
  if (url.pathname === "/api/local/subspace") {
    res.writeHead(200).end(JSON.stringify({
      activeHostId: null,
      servers: [],
      share: { hostName: "DieTest", shareMode: "direct", directPort: 45123, directAddress: null, addresses: [], listening: true, listeningPort: 45123, relayConnected: false, relayError: null, activeOffer: null, grants: [] },
      relayAuth: { authUrl: "https://id.laplace.live", relayUrl: "https://eidolon-relay.vrp.moe", status: "signed-out", user: null, deviceFlow: { status: "idle", userCode: null, verificationUri: null, verificationUriComplete: null, expiresAt: null, error: null } },
    }));
    return;
  }
  if (url.pathname === "/api/local/subspace/share/offer" && req.method === "POST") {
    res.writeHead(200).end(JSON.stringify({
      pairingUrl: "eidolon://pair?code=123",
      pairingCode: "123",
      qrSvg: "<svg/>",
      expiresAt: Date.now() + 60_000,
      state: {
        activeHostId: null,
        servers: [],
        share: { hostName: "DieTest", shareMode: "direct", directPort: 45123, directAddress: null, addresses: [], listening: true, listeningPort: 45123, relayConnected: false, relayError: null, activeOffer: null, grants: [] },
        relayAuth: { authUrl: "https://id.laplace.live", relayUrl: "https://eidolon-relay.vrp.moe", status: "signed-out", user: null, deviceFlow: { status: "idle", userCode: null, verificationUri: null, verificationUriComplete: null, expiresAt: null, error: null } },
      },
    }));
    setTimeout(() => {
      console.error("fatal headless boom");
      process.exit(2);
    }, 60);
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  mkdirSync(${JSON.stringify(dirname(infoPath))}, { recursive: true });
  writeFileSync(${JSON.stringify(tokenPath)}, token);
  writeFileSync(${JSON.stringify(infoPath)}, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port }));
  process.send?.({ kind: "listening", port });
});
`,
    );
    const controller = new AbortController();
    const io = captureIo();
    try {
      const code = await pairMain(["--json"], {
        ...io.io,
        signal: controller.signal,
        serverEntry: entry,
        pollMs: 10_000,
      });
      expect(code).toBe(2);
      expect(io.stderr()).toContain("exited unexpectedly (status 2)");
      expect(io.stderr()).toContain("fatal headless boom");
    } finally {
      controller.abort();
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("startHeadlessServer onExited unsubscribes listeners without retaining references", async () => {
    const work = mkdtempSync(join(tmpdir(), "eidolon-pair-onexited-"));
    const entry = join(work, "exit-server.mjs");
    const infoPath = lockInfoPath("local-server");
    const tokenPath = join(dataHome(), "local-token");
    writeFileSync(
      entry,
      `
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

const token = "exit-test-token-0123456789abcdef";
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/local/session") {
    const probe = url.searchParams.get("probe") ?? "";
    const proof = createHmac("sha256", token).update("probe:" + probe, "utf8").digest("base64url");
    res.writeHead(200).end(JSON.stringify({ proof }));
    return;
  }
  if (url.pathname === "/api/local/subspace") {
    res.writeHead(200).end(JSON.stringify({
      activeHostId: null,
      servers: [],
      share: { hostName: "ExitTest", shareMode: "direct", directPort: 45123, directAddress: null, addresses: [], listening: true, listeningPort: 45123, relayConnected: false, relayError: null, activeOffer: null, grants: [] },
      relayAuth: { authUrl: "https://id.laplace.live", relayUrl: "https://eidolon-relay.vrp.moe", status: "signed-out", user: null, deviceFlow: { status: "idle", userCode: null, verificationUri: null, verificationUriComplete: null, expiresAt: null, error: null } },
    }));
    setTimeout(() => process.exit(3), 120);
    return;
  }
  res.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  mkdirSync(${JSON.stringify(dirname(infoPath))}, { recursive: true });
  writeFileSync(${JSON.stringify(tokenPath)}, token);
  writeFileSync(${JSON.stringify(infoPath)}, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port }));
});
`,
    );
    const server = await startHeadlessServer(undefined, { entry });
    let removedCalls = 0;
    let keptCalls = 0;
    try {
      const unsubscribeRemoved = server.onExited(() => {
        removedCalls += 1;
      });
      unsubscribeRemoved();
      await new Promise<void>((resolve) => {
        server.onExited(() => {
          keptCalls += 1;
          resolve();
        });
      });
      expect(removedCalls).toBe(0);
      expect(keptCalls).toBe(1);
    } finally {
      await server.stop();
      rmSync(work, { recursive: true, force: true });
    }
  });
});
