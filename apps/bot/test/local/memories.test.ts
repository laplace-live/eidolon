// GET and DELETE /api/local/memories: each persona's memories of the local viewer, in the scope her
// calls store under, so forgetting with one persona leaves another's.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, installSettings } from "@eidolon/config";
import type { MemoryAdmin, MemorySummary } from "@eidolon/memory";
import { memoryScopeOf } from "../../src/local/identity.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot } from "./harness.ts";

/** mem0's scoping: user_id always, agent_id when given. */
class FakeMem0 {
  readonly points: { memory: string; user: string; agent: string | null }[] = [];

  add(memory: string, persona: string): void {
    const scope = memoryScopeOf(persona);
    this.points.push({ memory, user: scope.userId, agent: scope.agentId });
  }

  admin(): MemoryAdmin {
    const matching = (user: string, agent?: string) =>
      this.points.filter((p) => p.user === user && (agent === undefined || p.agent === agent));
    const summary = (memory: string): MemorySummary => ({
      id: memory,
      memory,
      created_at: null,
      updated_at: null,
      categories: null,
    });
    return {
      list: async (user, agent) => ({
        ok: true,
        value: matching(user, agent).map((p) => summary(p.memory)),
      }),
      forget: async (user, agent) => {
        for (const point of matching(user, agent))
          this.points.splice(this.points.indexOf(point), 1);
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
  cleanUpBoot();
});

function api(method: string, query = ""): Promise<Response> {
  return fetch(`${booted.base}/api/local/memories${query}`, {
    method,
    headers: booted.session,
  });
}

async function listed(query = ""): Promise<{ persona: string; memories: string[] }> {
  const response = await api("GET", query);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    persona: string;
    count: number;
    memories: MemorySummary[];
  };
  expect(body.count).toBe(body.memories.length);
  return { persona: body.persona, memories: body.memories.map((m) => m.memory as string) };
}

describe("memories per persona", () => {
  test("each persona lists only her own, and forgetting one leaves the other's", async () => {
    mem0.add("alpha: likes tea", "alpha");
    mem0.add("beta: likes rain", "beta");
    expect(await listed()).toEqual({ persona: "alpha", memories: ["alpha: likes tea"] });
    expect(await listed("?persona=beta")).toEqual({
      persona: "beta",
      memories: ["beta: likes rain"],
    });

    const forgot = await api("DELETE", "?persona=alpha");
    expect([forgot.status, await forgot.json()]).toEqual([200, { ok: true }]);
    expect((await listed()).memories).toEqual([]);
    expect((await listed("?persona=beta")).memories).toEqual(["beta: likes rain"]);
  });

  test("a persona's own memory.agentId is her scope", async () => {
    write("personas/beta/persona.yaml", "memory:\n  agentId: shop\n");
    mem0.add("beta in the shop", "beta");
    expect(mem0.points[0]?.agent).toBe("shop");
    expect((await listed("?persona=beta")).memories).toEqual(["beta in the shop"]);
    expect((await listed()).memories).toEqual([]);
  });

  test("an id that isn't a persona's is refused", async () => {
    expect((await api("GET", "?persona=..%2Fx")).status).toBe(400);
    expect((await api("GET", "?persona=nobody")).status).toBe(404);
    expect((await api("DELETE", "?persona=nobody")).status).toBe(404);
  });

  test("memory off is 503; a store that fails is 503 or 502", async () => {
    booted.fakes.memoryAdmin = null;
    const off = await api("GET");
    expect([off.status, (await off.json()).error.code]).toEqual([503, "unavailable"]);
    for (const [reason, status, code] of [
      ["unavailable", 503, "unavailable"],
      ["failed", 502, "upstream-failed"],
    ] as const) {
      booted.fakes.memoryAdmin = {
        list: async () => ({ ok: false, reason, error: new Error("qdrant down") }),
        forget: async () => ({ ok: false, reason, error: new Error("qdrant down") }),
      };
      for (const method of ["GET", "DELETE"]) {
        const response = await api(method);
        expect([method, response.status, (await response.json()).error.code]).toEqual([
          method,
          status,
          code,
        ]);
      }
    }
  });
});
