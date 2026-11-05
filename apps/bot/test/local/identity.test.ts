// The local viewer: granted by the session alone, free of the anonymous quota, and with memories
// kept per persona. A fake Mem0 engine filters by user and agent the way mem0 does.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, envOptional, installSettings, resetSettings } from "@eidolon/config";
import type { MemoryAdmin, MemorySummary } from "@eidolon/memory";
import {
  activeMemoryScope,
  LOCAL_MEMORY_USER,
  LOCAL_MID,
  type MemoryScope,
  memoryScopeOf,
} from "../../src/local/identity.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot } from "./harness.ts";

/** mem0's scoping: a filter on user_id, and on agent_id when one is given. */
class FakeMem0 {
  readonly points: { memory: string; user_id: string; agent_id: string | null }[] = [];

  add(memory: string, scope: MemoryScope): void {
    this.points.push({ memory, user_id: scope.userId, agent_id: scope.agentId });
  }

  #matching(userId: string, agentId: string | null | undefined) {
    return this.points.filter(
      (p) =>
        p.user_id === userId &&
        (agentId === undefined || agentId === null || p.agent_id === agentId),
    );
  }

  recall(scope: MemoryScope): string[] {
    return this.#matching(scope.userId, scope.agentId).map((p) => p.memory);
  }

  admin(): MemoryAdmin {
    const summary = (memory: string): MemorySummary => ({
      id: memory,
      memory,
      created_at: null,
      updated_at: null,
      categories: null,
    });
    return {
      list: async (userId, agentId) => ({
        ok: true,
        value: this.#matching(userId, agentId).map((p) => summary(p.memory)),
      }),
      forget: async (userId, agentId) => {
        for (const point of this.#matching(userId, agentId)) {
          this.points.splice(this.points.indexOf(point), 1);
        }
        return { ok: true, value: undefined };
      },
    };
  }
}

let booted: Booted;
let logs: CapturedLogs;
let mem0: FakeMem0;

function write(rel: string, text: string): void {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** What PUT personas/active will do: write settings.yaml, then install the settings again. */
function switchTo(persona: string): void {
  write("settings.yaml", `persona: ${persona}\n`);
  resetSettings();
  installSettings();
}

beforeEach(async () => {
  logs = captureLogs();
  write("personas/alpha/persona.yaml", "identity:\n  name: Alpha\n");
  write("personas/beta/persona.yaml", "identity:\n  name: Beta\n");
  write("settings.yaml", "persona: alpha\n");
  installSettings();
  booted = await bootFixture();
  mem0 = new FakeMem0();
  booted.fakes.memoryAdmin = mem0.admin();
});

afterEach(async () => {
  await booted.stop();
  logs.restore();
  delete process.env.EIDOLON_LOCAL_VIEWER_NAME;
  delete process.env.MEM0_AGENT_ID;
  cleanUpBoot();
});

function signedIn(extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: booted.cookie, Origin: booted.origin, ...extra };
}

async function offer(requestData: Record<string, unknown> = { audioQuality: "medium" }) {
  const response = await fetch(`${booted.base}/api/offer`, {
    method: "POST",
    body: JSON.stringify({ sdp: "v=0\r\n", type: "offer", requestData }),
    headers: signedIn({ "Content-Type": "application/json" }),
  });
  expect(response.status).toBe(200);
  return booted.fakes.offers.at(-1)?.admission;
}

/** The scope a call's Mem0 provider takes: user `String(mid)`, agent MEM0_AGENT_ID. */
async function callScope(): Promise<MemoryScope> {
  const admission = await offer();
  return {
    userId: String(admission?.user.mid),
    agentId: envOptional("MEM0_AGENT_ID") ?? null,
  };
}

async function listed(): Promise<string[]> {
  const response = await fetch(`${booted.base}/api/memories`, { headers: signedIn() });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user_id: string; memories: MemorySummary[] };
  expect(body.user_id).toBe(LOCAL_MEMORY_USER);
  return body.memories.map((m) => m.memory as string);
}

describe("offers", () => {
  test("carry the local viewer, logged in, with no quota and no token", async () => {
    process.env.EIDOLON_LOCAL_VIEWER_NAME = " 小明 ";
    const admission = await offer({ audioQuality: "low" });
    expect(admission?.user).toEqual({
      mid: LOCAL_MID,
      uname: "小明",
      face: null,
      isLoggedIn: true,
    });
    expect(admission?.quota).toBeNull();
    expect(admission?.token).toBeNull();
    expect(admission?.opusBitrateBps).toBe(64000);
    expect(admission?.clientIp).toBe("127.0.0.1");
    expect(booted.fakes.admitted).toEqual([]);
  });

  test("read the name on every offer; without one the viewer is still logged in", async () => {
    expect((await offer())?.user.uname).toBeNull();
    process.env.EIDOLON_LOCAL_VIEWER_NAME = "阿绿";
    expect((await offer())?.user.uname).toBe("阿绿");
    delete process.env.EIDOLON_LOCAL_VIEWER_NAME;
    write("settings.yaml", "persona: alpha\nlocal:\n  viewerName: 小红\n");
    installSettings();
    const admission = await offer();
    expect([admission?.user.uname, admission?.user.isLoggedIn]).toEqual(["小红", true]);
  });

  test("never take the identity from the body", async () => {
    const admission = await offer({ loginSyncToken: "a-real-looking-token", audioQuality: "best" });
    expect(admission?.user.mid).toBe(LOCAL_MID);
    expect(admission?.token).toBeNull();
    expect(booted.fakes.admitted).toEqual([]);
  });

  test("are never rationed: the anonymous quota is five an hour", async () => {
    for (let i = 0; i < 8; i++) await offer();
    expect(booted.fakes.offers).toHaveLength(8);
  });

  test("the preflight answers as for a logged-in viewer", async () => {
    const response = await fetch(`${booted.base}/api/offer/preflight`, {
      method: "POST",
      body: "{}",
      headers: signedIn(),
    });
    expect([response.status, await response.text()]).toEqual([
      200,
      '{"ok":true,"anonymous":false}',
    ]);
  });
});

describe("memories per persona", () => {
  test("two personas, one viewer: no cross-recall, and forgetting one leaves the other", async () => {
    const alpha = await callScope();
    expect(alpha).toEqual({ userId: LOCAL_MEMORY_USER, agentId: "alpha" });
    mem0.add("alpha: the viewer likes tea", alpha);

    switchTo("beta");
    const beta = await callScope();
    expect(beta).toEqual({ userId: LOCAL_MEMORY_USER, agentId: "beta" });
    mem0.add("beta: the viewer likes rain", beta);

    expect(mem0.recall(beta)).toEqual(["beta: the viewer likes rain"]);
    expect(await listed()).toEqual(["beta: the viewer likes rain"]);
    switchTo("alpha");
    expect(mem0.recall(await callScope())).toEqual(["alpha: the viewer likes tea"]);
    expect(await listed()).toEqual(["alpha: the viewer likes tea"]);

    const forgot = await fetch(`${booted.base}/api/memories/forget`, {
      method: "POST",
      headers: signedIn(),
    });
    expect([forgot.status, await forgot.json()]).toEqual([200, { ok: true, user_id: "0" }]);
    expect(await listed()).toEqual([]);
    switchTo("beta");
    expect(await listed()).toEqual(["beta: the viewer likes rain"]);
  });

  test("the scope the admin lists is the one a call stores under", async () => {
    expect(activeMemoryScope()).toEqual(await callScope());
    switchTo("beta");
    expect(activeMemoryScope()).toEqual(await callScope());
  });

  test("an inactive persona's scope is its own", () => {
    expect(memoryScopeOf("beta")).toEqual({ userId: "0", agentId: "beta" });
    write("personas/beta/persona.yaml", "memory:\n  agentId: shared\n");
    expect(memoryScopeOf("beta")).toEqual({ userId: "0", agentId: "shared" });
    process.env.MEM0_AGENT_ID = "everyone";
    expect(memoryScopeOf("beta")).toEqual({ userId: "0", agentId: "everyone" });
  });

  test("a persona's own memory.agentId, or the environment's, wins over the default", async () => {
    write("personas/alpha/persona.yaml", "memory:\n  agentId: shop\n");
    installSettings();
    expect((await callScope()).agentId).toBe("shop");
    process.env.MEM0_AGENT_ID = "from-env";
    expect((await callScope()).agentId).toBe("from-env");
  });

  test("memory off is 503 unavailable; a failing store is 503 or 502", async () => {
    booted.fakes.memoryAdmin = null;
    const off = await fetch(`${booted.base}/api/memories`, { headers: signedIn() });
    expect([off.status, (await off.json()).error.code]).toEqual([503, "unavailable"]);
    for (const [reason, status, code] of [
      ["unavailable", 503, "unavailable"],
      ["failed", 502, "upstream-failed"],
    ] as const) {
      booted.fakes.memoryAdmin = {
        list: async () => ({ ok: false, reason, error: new Error("qdrant down") }),
        forget: async () => ({ ok: false, reason, error: new Error("qdrant down") }),
      };
      const response = await fetch(`${booted.base}/api/memories/forget`, {
        method: "POST",
        headers: signedIn(),
      });
      expect([response.status, (await response.json()).error.code]).toEqual([status, code]);
    }
  });
});
