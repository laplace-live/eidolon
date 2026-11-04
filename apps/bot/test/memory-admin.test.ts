import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LoggedInUser } from "@eidolon/access";
import type { AdminOutcome, MemoryAdmin, MemorySummary } from "@eidolon/memory";
import { createBotApp } from "../src/app.ts";
import {
  type CapturedLogs,
  captureLogs,
  fakeAccess,
  fakeParts,
  ORIGIN,
  type Served,
  serve,
  VIEWER,
} from "./fakes.ts";

class QdrantError extends Error {}

const MEMORIES: MemorySummary[] = [
  {
    id: "8c4d6f0e-1b2a-4c3d-9e8f-7a6b5c4d3e2f",
    memory: "用户对海鲜过敏",
    created_at: "2026-04-12T08:30:11.123456+00:00",
    updated_at: "2026-04-12T08:30:11.123456+00:00",
    categories: null,
  },
  {
    id: "0f1e2d3c-4b5a-4968-8776-655443322110",
    memory: 'says "hi"\n',
    created_at: "2025-12-01T03:04:05-07:00",
    updated_at: null,
    categories: null,
  },
];

let served: Served | null = null;
let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(async () => {
  logs.restore();
  await served?.stop();
  served = null;
});

interface Seen {
  authorizations: (string | null)[];
  userIds: string[];
}

function start(
  caller: LoggedInUser | null,
  admin: MemoryAdmin | null,
): { url: string; seen: Seen } {
  const seen: Seen = { authorizations: [], userIds: [] };
  const record = (outcome: () => Promise<AdminOutcome<any>>) => async (userId: string) => {
    seen.userIds.push(userId);
    return outcome();
  };
  const tracked = admin && {
    list: record(() => admin.list("")),
    forget: record(() => admin.forget("")),
  };
  served = serve(
    createBotApp(
      fakeParts({
        access: fakeAccess({
          resolveBearerCaller: async (authorization) => {
            seen.authorizations.push(authorization);
            return caller;
          },
        }),
        memoryAdmin: tracked,
      }),
    ),
  );
  return { url: served.url, seen };
}

function admin(
  list: AdminOutcome<MemorySummary[]>,
  forget: AdminOutcome<void> = { ok: true, value: undefined },
): MemoryAdmin {
  return { list: async () => list, forget: async () => forget };
}

const ENDPOINTS = [
  { method: "GET", path: "/api/memories", unauthorized: '{"error":"需要登录后才能查看记忆"}' },
  {
    method: "POST",
    path: "/api/memories/forget",
    unauthorized: '{"error":"需要登录后才能管理记忆"}',
  },
] as const;

async function call(url: string, method: string, authorization?: string) {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (authorization !== undefined) headers.Authorization = authorization;
  const response = await fetch(url, { method, headers });
  return { response, body: await response.text() };
}

describe("auth comes first", () => {
  for (const { method, path, unauthorized } of ENDPOINTS) {
    for (const configured of [true, false]) {
      test(`${method} ${path} answers its own 401 for every anonymous caller (Mem0 ${configured ? "configured" : "unconfigured"})`, async () => {
        const { url, seen } = start(null, configured ? admin({ ok: true, value: [] }) : null);
        for (const authorization of [undefined, "Basic abc", "Bearer ", "Bearer revoked"]) {
          const { response, body } = await call(`${url}${path}`, method, authorization);
          expect(response.status).toBe(401);
          expect(response.headers.get("content-type")).toBe("application/json");
          expect(body).toBe(unauthorized);
          expect(response.headers.get("x-fake-cors")).toBe(ORIGIN);
        }
        expect(seen.authorizations).toEqual([null, "Basic abc", "Bearer", "Bearer revoked"]);
        expect(seen.userIds).toEqual([]);
        expect(logs.records).toEqual([]);
      });
    }
  }
});

describe("GET /api/memories", () => {
  test("lists the caller's memories with null fields kept and count equal to the list", async () => {
    const { url, seen } = start(VIEWER, admin({ ok: true, value: MEMORIES }));
    const { response, body } = await call(`${url}/api/memories`, "GET", "Bearer tok");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(body).toBe(
      '{"user_id":"12345678","uname":"明前奶绿粉丝","count":2,"memories":[' +
        '{"id":"8c4d6f0e-1b2a-4c3d-9e8f-7a6b5c4d3e2f","memory":"用户对海鲜过敏",' +
        '"created_at":"2026-04-12T08:30:11.123456+00:00","updated_at":"2026-04-12T08:30:11.123456+00:00","categories":null},' +
        '{"id":"0f1e2d3c-4b5a-4968-8776-655443322110","memory":"says \\"hi\\"\\n",' +
        '"created_at":"2025-12-01T03:04:05-07:00","updated_at":null,"categories":null}]}',
    );
    expect(seen.userIds).toEqual(["12345678"]);
    expect(logs.lines()).toEqual([
      "INFO [memory-admin] Listed 2 memories for mid=12345678 ('明前奶绿粉丝')",
    ]);
  });

  test("an empty list is a plain 200, and a missing uname is null and None", async () => {
    const { url } = start({ ...VIEWER, uname: null }, admin({ ok: true, value: [] }));
    const { response, body } = await call(`${url}/api/memories`, "GET", "Bearer tok");
    expect(response.status).toBe(200);
    expect(body).toBe('{"user_id":"12345678","uname":null,"count":0,"memories":[]}');
    expect(logs.lines()).toEqual(["INFO [memory-admin] Listed 0 memories for mid=12345678 (None)"]);
  });

  test("unconfigured memory is a 503 after auth, with no log", async () => {
    const { url } = start(VIEWER, null);
    const { response, body } = await call(`${url}/api/memories`, "GET", "Bearer tok");
    expect(response.status).toBe(503);
    expect(body).toBe('{"error":"Mem0 service unavailable"}');
    expect(logs.records).toEqual([]);
  });

  test("an unreachable vector store is a 503 with the Could not reach line", async () => {
    const { url } = start(
      VIEWER,
      admin({ ok: false, reason: "unavailable", error: new Error("connect ECONNREFUSED") }),
    );
    const { response, body } = await call(`${url}/api/memories`, "GET", "Bearer tok");
    expect(response.status).toBe(503);
    expect(body).toBe('{"error":"Mem0 service unavailable"}');
    expect(logs.lines()).toEqual([
      "ERROR [memory-admin] Could not reach the Mem0 vector store: connect ECONNREFUSED",
    ]);
  });

  test("a failed get_all is a 502 logged with the exception type", async () => {
    const { url } = start(
      VIEWER,
      admin({ ok: false, reason: "failed", error: new QdrantError("Bad Request") }),
    );
    const { response, body } = await call(`${url}/api/memories`, "GET", "Bearer tok");
    expect(response.status).toBe(502);
    expect(body).toBe('{"error":"Failed to load memories"}');
    expect(logs.lines()).toEqual([
      "ERROR [memory-admin] get_all failed for mid=12345678: QdrantError: Bad Request",
    ]);
  });
});

describe("POST /api/memories/forget", () => {
  test("wipes the caller's memories, idempotently", async () => {
    const { url, seen } = start(VIEWER, admin({ ok: true, value: [] }));
    for (let i = 0; i < 2; i++) {
      const { response, body } = await call(`${url}/api/memories/forget`, "POST", "Bearer tok");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(body).toBe('{"ok":true,"user_id":"12345678"}');
    }
    expect(seen.userIds).toEqual(["12345678", "12345678"]);
    expect(logs.lines()).toEqual([
      "INFO [memory-admin] Wiped Mem0 memories for mid=12345678 ('明前奶绿粉丝')",
      "INFO [memory-admin] Wiped Mem0 memories for mid=12345678 ('明前奶绿粉丝')",
    ]);
  });

  test("unconfigured memory is a 503", async () => {
    const { url } = start(VIEWER, null);
    const { response, body } = await call(`${url}/api/memories/forget`, "POST", "Bearer tok");
    expect(response.status).toBe(503);
    expect(body).toBe('{"error":"Mem0 service unavailable"}');
  });

  test("an unreachable vector store is a 503 with the Could not reach line", async () => {
    const { url } = start(
      VIEWER,
      admin(
        { ok: true, value: [] },
        { ok: false, reason: "unavailable", error: new Error("timed out") },
      ),
    );
    const { response, body } = await call(`${url}/api/memories/forget`, "POST", "Bearer tok");
    expect(response.status).toBe(503);
    expect(body).toBe('{"error":"Mem0 service unavailable"}');
    expect(logs.lines()).toEqual([
      "ERROR [memory-admin] Could not reach the Mem0 vector store: timed out",
    ]);
  });

  test("a failure named after mem0's exception logs that name, as type(e).__name__ did", async () => {
    const valueError = Object.assign(new Error("Memory with id p1 not found."), {
      name: "ValueError",
    });
    const { url } = start(
      VIEWER,
      admin({ ok: true, value: [] }, { ok: false, reason: "failed", error: valueError }),
    );
    const { response } = await call(`${url}/api/memories/forget`, "POST", "Bearer tok");
    expect(response.status).toBe(502);
    expect(logs.lines()).toEqual([
      "ERROR [memory-admin] delete_all failed for mid=12345678: ValueError: Memory with id p1 not found.",
    ]);
  });

  test("a failed delete_all is a 502 logged with the exception type", async () => {
    const { url } = start(
      VIEWER,
      admin(
        { ok: true, value: [] },
        { ok: false, reason: "failed", error: new TypeError("fetch failed") },
      ),
    );
    const { response, body } = await call(`${url}/api/memories/forget`, "POST", "Bearer tok");
    expect(response.status).toBe(502);
    expect(body).toBe('{"error":"Failed to delete memories"}');
    expect(logs.lines()).toEqual([
      "ERROR [memory-admin] delete_all failed for mid=12345678: TypeError: fetch failed",
    ]);
  });
});
