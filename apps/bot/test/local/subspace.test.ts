import "../../../../packages/config/test/isolated-guard.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatSummary } from "@eidolon/chat";
import { killTree, newId, spawnProcess } from "@eidolon/config";
import {
  parsePairingInput,
  performPairingHandshake,
  SubspaceClient,
  SubspaceConnectError,
  type SubspaceManager,
} from "@eidolon/subspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  type ErrorBody,
  EXPECTED_HOST_HEADER,
  type SubspaceStateResponse,
} from "../../src/local/api.ts";
import { createLocalRouter } from "../../src/local/router.ts";
import { subspaceRoutes } from "../../src/local/routes/subspace.ts";
import type { RouteRequest } from "../../src/routing.ts";
import { captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot, fixtureDist } from "./harness.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  cleanUpBoot();
});

const READY_PREFIX = "SUBSPACE_PEER_READY:";

async function spawnPeerServer(remoteHome: string, distDir: string) {
  const child = spawnProcess(
    [process.execPath, join(import.meta.dirname, "subspace-peer-child.ts"), distDir],
    {
      env: { ...process.env, EIDOLON_HOME: remoteHome, OPENROUTER_API_KEY: "sk-or-test" },
      detached: true,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  cleanups.push(async () => {
    child.stdin?.end();
    if (child.exitCode === null) killTree(child.pid, { wait: true });
    await child.exited.catch(() => {});
  });

  const stderr: string[] = [];
  const decoder = new TextDecoder();
  if (child.stderr !== null) {
    void (async () => {
      for await (const chunk of child.stderr!) stderr.push(decoder.decode(chunk, { stream: true }));
    })().catch(() => {});
  }

  const ready = await new Promise<{
    readonly baseUrl: string;
    readonly pairingUrl: string;
    readonly remoteChatId: string;
  }>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`Peer child timed out: ${stderr.join("")}`)));
    }, 15_000);
    void (async () => {
      try {
        if (child.stdout === null) throw new Error("Missing child stdout");
        let buffer = "";
        for await (const chunk of child.stdout) {
          // Keep draining child stdout until EOF so breaking early never causes SIGPIPE on logs.
          if (settled) continue;
          buffer += decoder.decode(chunk, { stream: true });
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline === -1) break;
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith(READY_PREFIX)) continue;
            const parsed = JSON.parse(line.slice(READY_PREFIX.length)) as {
              baseUrl: string;
              pairingUrl: string;
              remoteChatId: string;
            };
            buffer = "";
            settle(() => resolve(parsed));
            break;
          }
        }
        settle(() =>
          reject(new Error(`Peer child closed stdout without ready line: ${stderr.join("")}`)),
        );
      } catch (err) {
        settle(() => reject(err));
      }
    })();
    void child.exited.then((code) => {
      settle(() => reject(new Error(`Peer child exited early (${code}): ${stderr.join("")}`)));
    });
  });

  return {
    ...ready,
    stop: async () => {
      child.stdin?.end();
      if (child.exitCode === null) killTree(child.pid, { wait: true });
      await child.exited.catch(() => {});
    },
  };
}

describe("Local server Subspace proxy & host switching", () => {
  test("pairs over Direct, proxies API routes, honors X-Eidolon-Target: local, marks remote restart, and restores local", async () => {
    const prevKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    cleanups.push(() => {
      if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prevKey;
    });
    const remoteHome = mkdtempSync(join(tmpdir(), "eidolon-subspace-peer-"));
    const remoteDist = fixtureDist();
    cleanups.push(() => {
      rmSync(remoteHome, { recursive: true, force: true });
      rmSync(remoteDist, { recursive: true, force: true });
    });

    const peer = await spawnPeerServer(remoteHome, remoteDist);
    const local: Booted = await bootFixture();
    cleanups.push(() => local.stop());

    // Create a local chat distinct from the remote peer's chat.
    const createLocal = await fetch(`${local.base}/api/local/chats`, {
      method: "POST",
      headers: { ...local.session, "content-type": "application/json" },
      body: JSON.stringify({ participants: ["milky-green"] }),
    });
    expect(createLocal.status).toBe(201);
    const { id: localChatId } = (await createLocal.json()) as { id: string };
    await fetch(`${local.base}/api/local/chats/${encodeURIComponent(localChatId)}`, {
      method: "PATCH",
      headers: { ...local.session, "content-type": "application/json" },
      body: JSON.stringify({ title: "Local Computer Chat" }),
    });

    // Pair local Server A with remote Server B and activate it immediately.
    const pairRes = await fetch(`${local.base}/api/local/subspace/servers`, {
      method: "POST",
      headers: { ...local.session, "content-type": "application/json" },
      body: JSON.stringify({ code: peer.pairingUrl, name: "Studio Remote", activate: true }),
    });
    expect(pairRes.status).toBe(201);
    const pairedState = (await pairRes.json()) as SubspaceStateResponse;
    expect(pairedState.servers).toHaveLength(1);
    const remoteId = pairedState.servers[0]!.id;
    expect(pairedState.activeHostId).toBe(remoteId);
    expect(pairedState.servers[0]?.name).toBe("Studio Remote");

    // 1. Proxied GET /api/local/chats returns Server B's chat and tags X-Eidolon-Subspace-Host.
    const remoteChatsRes = await fetch(`${local.base}/api/local/chats`, {
      headers: local.session,
    });
    expect(remoteChatsRes.status).toBe(200);
    expect(remoteChatsRes.headers.get("x-eidolon-subspace-host")).toBe(remoteId);
    const remoteChats = (await remoteChatsRes.json()) as ChatSummary[];
    expect(remoteChats.map((c) => [c.id, c.title])).toEqual([
      [peer.remoteChatId, "Remote Subspace Chat"],
    ]);

    // 2. GET /api/local/tasks includes X-Eidolon-Subspace-Host identifying the active remote server.
    const remoteTasksRes = await fetch(`${local.base}/api/local/tasks`, {
      headers: local.session,
    });
    expect(remoteTasksRes.status).toBe(200);
    expect(remoteTasksRes.headers.get("x-eidolon-subspace-host")).toBe(remoteId);

    // 3. /api/local/subspace remains local even when a remote host is active.
    const subRes = await fetch(`${local.base}/api/local/subspace`, { headers: local.session });
    expect(subRes.status).toBe(200);
    expect(((await subRes.json()) as SubspaceStateResponse).activeHostId).toBe(remoteId);

    // 4. X-Eidolon-Target: local bypasses the active Subspace proxy.
    const bypassedChatsRes = await fetch(`${local.base}/api/local/chats`, {
      headers: { ...local.session, "x-eidolon-target": "local" },
    });
    expect(bypassedChatsRes.status).toBe(200);
    const bypassedChats = (await bypassedChatsRes.json()) as ChatSummary[];
    expect(bypassedChats.map((c) => [c.id, c.title])).toEqual([
      [localChatId, "Local Computer Chat"],
    ]);

    // 4b. POST /api/local/subspace/active with an unknown server id returns 404 without dropping the active host.
    const missingActiveRes = await fetch(`${local.base}/api/local/subspace/active`, {
      method: "POST",
      headers: { ...local.session, "content-type": "application/json" },
      body: JSON.stringify({ hostId: "srv_does_not_exist" }),
    });
    expect(missingActiveRes.status).toBe(404);
    expect(await missingActiveRes.json()).toMatchObject({
      error: { code: "unknown-subspace-server" },
    });
    const stillRemoteChats = await fetch(`${local.base}/api/local/chats`, {
      headers: local.session,
    });
    expect(stillRemoteChats.status).toBe(200);
    expect(stillRemoteChats.headers.get("x-eidolon-subspace-host")).toBe(remoteId);

    // 4c. Generating a direct share offer without address/rotate reuses the active offer.
    const offer1Res = await fetch(`${local.base}/api/local/subspace/share/offer`, {
      method: "POST",
      headers: { ...local.session, "content-type": "application/json" },
      body: JSON.stringify({ mode: "direct", address: "127.0.0.1", port: 0 }),
    });
    expect(offer1Res.status).toBe(200);
    const offer1 = (await offer1Res.json()) as { pairingCode: string };
    const offer2Res = await fetch(`${local.base}/api/local/subspace/share/offer`, {
      method: "POST",
      headers: { ...local.session, "content-type": "application/json" },
      body: JSON.stringify({ mode: "direct" }),
    });
    expect(offer2Res.status).toBe(200);
    const offer2 = (await offer2Res.json()) as { pairingCode: string };
    expect(offer2.pairingCode).toBe(offer1.pairingCode);

    // 4d. X-Eidolon-Expected-Host rejects mismatched expectations (local->remote) while allowing matches and bypasses.
    const mismatchToLocal = await fetch(`${local.base}/api/local/chats`, {
      headers: { ...local.session, [EXPECTED_HOST_HEADER]: "local" },
    });
    expect(mismatchToLocal.status).toBe(409);
    expect(await mismatchToLocal.json()).toMatchObject({ error: { code: "conflict" } });

    const fallbackMismatch = await fetch(`${local.base}/api/offer`, {
      method: "DELETE",
      headers: { ...local.session, [EXPECTED_HOST_HEADER]: "local" },
    });
    expect(fallbackMismatch.status).toBe(409);
    expect(await fallbackMismatch.json()).toMatchObject({ error: { code: "conflict" } });

    const matchingRemote = await fetch(`${local.base}/api/local/chats`, {
      headers: { ...local.session, [EXPECTED_HOST_HEADER]: remoteId },
    });
    expect(matchingRemote.status).toBe(200);

    const bypassedWithHeader = await fetch(`${local.base}/api/local/chats`, {
      headers: {
        ...local.session,
        "x-eidolon-target": "local",
        [EXPECTED_HOST_HEADER]: remoteId,
      },
    });
    expect(bypassedWithHeader.status).toBe(200);

    const localOnlyWithHeader = await fetch(`${local.base}/api/local/subspace`, {
      headers: { ...local.session, [EXPECTED_HOST_HEADER]: "local" },
    });
    expect(localOnlyWithHeader.status).toBe(200);

    // 4e. Proxied fallback routes preserve botFallback 405 + Allow and 404 semantics through dispatchLocal.
    const proxied405 = await fetch(`${local.base}/api/offer`, {
      method: "DELETE",
      headers: local.session,
    });
    expect(proxied405.status).toBe(405);
    expect(proxied405.headers.get("allow")).toBe("POST");
    expect(await proxied405.json()).toEqual({ detail: "Method Not Allowed" });

    const proxied404 = await fetch(`${local.base}/api/nonexistent`, {
      headers: local.session,
    });
    expect(proxied404.status).toBe(404);
    expect(await proxied404.json()).toEqual({ detail: "Not Found" });

    // 5. Switching activeHostId back to null returns local chats and x-eidolon-subspace-host: local,
    //    while stale clients expecting the remote host receive 409 conflict without mutating local state.
    const switchLocalRes = await fetch(`${local.base}/api/local/subspace/active`, {
      method: "POST",
      headers: { ...local.session, "content-type": "application/json" },
      body: JSON.stringify({ hostId: null }),
    });
    expect(switchLocalRes.status).toBe(200);

    const staleGet = await fetch(`${local.base}/api/local/chats`, {
      headers: { ...local.session, [EXPECTED_HOST_HEADER]: remoteId },
    });
    expect(staleGet.status).toBe(409);
    expect(await staleGet.json()).toMatchObject({ error: { code: "conflict" } });

    const staleMutate = await fetch(`${local.base}/api/local/chats`, {
      method: "POST",
      headers: {
        ...local.session,
        "content-type": "application/json",
        [EXPECTED_HOST_HEADER]: remoteId,
      },
      body: JSON.stringify({ participants: ["milky-green"] }),
    });
    expect(staleMutate.status).toBe(409);
    expect(await staleMutate.json()).toMatchObject({ error: { code: "conflict" } });

    const staleFallback = await fetch(`${local.base}/api/offer`, {
      method: "DELETE",
      headers: { ...local.session, [EXPECTED_HOST_HEADER]: remoteId },
    });
    expect(staleFallback.status).toBe(409);
    expect(await staleFallback.json()).toMatchObject({ error: { code: "conflict" } });

    const unauthStale = await fetch(`${local.base}/api/local/chats`, {
      headers: { [EXPECTED_HOST_HEADER]: remoteId },
    });
    expect(unauthStale.status).toBe(401);

    const localChatsAgainRes = await fetch(`${local.base}/api/local/chats`, {
      headers: { ...local.session, [EXPECTED_HOST_HEADER]: "local" },
    });
    expect(localChatsAgainRes.status).toBe(200);
    expect(localChatsAgainRes.headers.get("x-eidolon-subspace-host")).toBe("local");
    const localChatsAgain = (await localChatsAgainRes.json()) as ChatSummary[];
    expect(localChatsAgain.map((c) => c.id)).toEqual([localChatId]);
    const localTasksRes = await fetch(`${local.base}/api/local/tasks`, {
      headers: local.session,
    });
    expect(localTasksRes.headers.get("x-eidolon-subspace-host")).toBe("local");

    // 6. Switching back to remote and calling POST /api/local/restart tags X-Eidolon-Subspace: remote
    //    and restarts the remote peer without restarting local Server A.
    await fetch(`${local.base}/api/local/subspace/active`, {
      method: "POST",
      headers: { ...local.session, "content-type": "application/json" },
      body: JSON.stringify({ hostId: remoteId }),
    });
    const restartRes = await fetch(`${local.base}/api/local/restart`, {
      method: "POST",
      headers: local.session,
    });
    expect(restartRes.status).toBe(200);
    expect(restartRes.headers.get("x-eidolon-subspace")).toBe("remote");
    expect(local.io.exits).toEqual([]);

    // 7. When the active remote peer becomes unreachable, proxy returns 502 localFailure with hex error.id.
    await peer.stop();
    const downRes = await fetch(`${local.base}/api/local/chats`, { headers: local.session });
    expect(downRes.status).toBe(502);
    const downBody = (await downRes.json()) as ErrorBody;
    expect(downBody.error.code).toBe("subspace-unreachable");
    expect(downBody.error.id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("tunneled /api/offer sets allowHostCandidates while direct local offers keep it false, and dispatchLocal preserves botFallback 405 + Allow", async () => {
    const host = await bootFixture();
    cleanups.push(() => host.stop());

    const offerRes = await fetch(`${host.base}/api/local/subspace/share/offer`, {
      method: "POST",
      headers: { ...host.session, "content-type": "application/json" },
      body: JSON.stringify({ mode: "direct", address: "127.0.0.1", port: 0 }),
    });
    expect(offerRes.status).toBe(200);
    const { pairingUrl } = (await offerRes.json()) as { pairingUrl: string };
    const parsed = parsePairingInput(pairingUrl);
    if (!parsed.ok) throw new Error(parsed.reason);

    const handshake = await performPairingHandshake(parsed.offer);
    const client = new SubspaceClient(
      {
        id: newId(),
        name: "Test Host",
        hostPublicKeyB64: parsed.offer.hostPublicKeyB64,
        grantId: handshake.grantId,
        deviceToken: handshake.deviceToken,
        mode: "direct",
        endpoint: parsed.offer.endpoint,
        addedAt: Date.now(),
        lastConnectedAt: Date.now(),
        lastVersion: handshake.serverVersion,
      },
      {},
      handshake.tunnel,
    );
    cleanups.push(() => client.stop());

    const directOffer = await fetch(`${host.base}/api/offer`, {
      method: "POST",
      headers: { ...host.session, "content-type": "application/json" },
      body: JSON.stringify({ sdp: "v=0\r\n", type: "offer" }),
    });
    expect(directOffer.status).toBe(200);
    expect(host.fakes.offers.at(-1)?.admission.allowHostCandidates).toBe(false);

    const tunneledOffer = await client.proxyFetch(
      new Request("http://subspace.local/api/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sdp: "v=0\r\n", type: "offer" }),
      }),
      "/api/offer",
    );
    expect(tunneledOffer.status).toBe(200);
    expect(host.fakes.offers.at(-1)?.admission.allowHostCandidates).toBe(true);

    const tunneledMethodNotAllowed = await client.proxyFetch(
      new Request("http://subspace.local/api/offer", { method: "DELETE" }),
      "/api/offer",
    );
    expect(tunneledMethodNotAllowed.status).toBe(405);
    expect(tunneledMethodNotAllowed.headers.get("allow")).toBe("POST");
  });
});

describe("subspaceRoutes error handling", () => {
  test("returns static messages for mapped codes and rethrows unexpected errors as 500 internal", async () => {
    const logs = captureLogs();
    cleanups.push(() => logs.restore());

    const fakeManager = {
      getState: async () => {
        throw new Error("SQLITE_CANTOPEN: /secret/db/path");
      },
      setActiveHostId: async () => {
        throw new SubspaceConnectError(
          "subspace-unreachable",
          "connect ECONNREFUSED 10.9.8.7:44321",
        );
      },
      revokeGrant: async () => {
        throw Object.assign(new Error("raw internal conflict detail"), { code: "conflict" });
      },
      startRelayAuth: async () => {
        throw Object.assign(new Error("connect ECONNREFUSED 10.9.8.7:4444"), {
          code: "upstream-failed",
        });
      },
    } as unknown as SubspaceManager;

    const router = createLocalRouter(subspaceRoutes(fakeManager), () => "bearer");
    const server = { requestIP: () => ({ address: "127.0.0.1", port: 12345 }) };
    const req = (url: string, init?: RequestInit): RouteRequest =>
      Object.assign(new Request(url, init), { params: {} });

    const unexpectedRes = await router(
      req("http://127.0.0.1:7860/api/local/subspace", { method: "GET" }),
      server,
    );
    expect(unexpectedRes.status).toBe(500);
    const unexpectedText = await unexpectedRes.text();
    const unexpectedJson = JSON.parse(unexpectedText) as ErrorBody;
    expect(unexpectedJson.error.code).toBe("internal");
    expect(unexpectedJson.error.id).toMatch(/^[0-9a-f]{8}$/);
    expect(unexpectedText).not.toContain("SQLITE_CANTOPEN");
    expect(unexpectedText).not.toContain("/secret/db/path");

    const unreachableRes = await router(
      req("http://127.0.0.1:7860/api/local/subspace/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: "srv-1" }),
      }),
      server,
    );
    expect(unreachableRes.status).toBe(502);
    const unreachableText = await unreachableRes.text();
    const unreachableJson = JSON.parse(unreachableText) as ErrorBody;
    expect(unreachableJson.error).toEqual({
      code: "subspace-unreachable",
      message: "Could not reach the Subspace server",
    });
    expect(unreachableText).not.toContain("ECONNREFUSED");
    expect(unreachableText).not.toContain("10.9.8.7");

    const conflictRes = await router(
      req("http://127.0.0.1:7860/api/local/subspace/share/grants/g1", {
        method: "DELETE",
      }),
      server,
    );
    expect(conflictRes.status).toBe(409);
    const conflictText = await conflictRes.text();
    const conflictJson = JSON.parse(conflictText) as ErrorBody;
    expect(conflictJson.error).toEqual({
      code: "conflict",
      message: "Active Subspace server changed; reload and try again",
    });
    expect(conflictText).not.toContain("raw internal conflict detail");

    const authStartRes = await router(
      req("http://127.0.0.1:7860/api/local/subspace/auth/start", { method: "POST" }),
      server,
    );
    expect(authStartRes.status).toBe(502);
    const authStartText = await authStartRes.text();
    expect(JSON.parse(authStartText)).toEqual({
      error: {
        code: "upstream-failed",
        message: "Could not reach the Relay auth server",
      },
    });
    expect(authStartText).not.toContain("ECONNREFUSED");

    const badOfferRes = await router(
      req("http://127.0.0.1:7860/api/local/subspace/share/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "direct", address: "http://127.0.0.1/bad" }),
      }),
      server,
    );
    expect(badOfferRes.status).toBe(400);
    expect((await badOfferRes.json()) as ErrorBody).toMatchObject({
      error: { code: "bad-request" },
    });
  });
});
