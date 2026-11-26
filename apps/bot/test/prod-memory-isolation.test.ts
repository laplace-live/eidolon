// Production multi-viewer memory isolation on local Zvec: startBotServer without the local
// extension, read-only EIDOLON_HOME (matching Docker's `/data:ro`), a separate writable MEM0_DIR +
// history.db volume, real Workers token validation, real Zvec persona RAG, and real MemoryEngine
// across `/api/chat/turn`, `GET /api/memories` and `POST /api/memories/forget`.
import "../../../packages/config/test/isolated-guard.ts";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as access from "@eidolon/access";
import { CHAT_FORMAT, type ChatHeader } from "@eidolon/chat";
import { activePersona, resetSettings } from "@eidolon/config";
import * as memory from "@eidolon/memory";
import * as retrieval from "@eidolon/retrieval";
import { iceServiceFromEnv } from "@eidolon/turn";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type ServedFetch, serveFetch } from "../../../packages/config/test/http.ts";
import { MIN_CHAT_SECRET_LENGTH } from "../src/chat/sig.ts";
import { createMcpHandler } from "../src/mcp/index.ts";
import { type BotServer, startBotServer } from "../src/server.ts";
import { eventsIn, linesOf, productionDeps } from "./chat/harness.ts";
import { type CapturedLogs, captureLogs, ORIGIN } from "./fakes.ts";

const SECRET = "p".repeat(MIN_CHAT_SECRET_LENGTH);
const IP_HEADER = "x-prod-ip";

interface SentMessage {
  readonly role: string;
  readonly content: unknown;
}

const mindCalls: { readonly messages: readonly SentMessage[] }[] = [];
let extractionCalls = 0;
let tokenSuffix = 0;
let provider: ServedFetch;

function setTreeMode(root: string, dirMode: number, fileMode: number): void {
  if (process.platform === "win32") return;
  const walk = (target: string): void => {
    const stat = statSync(target);
    if (stat.isDirectory()) {
      chmodSync(target, 0o700);
      for (const name of readdirSync(target)) walk(join(target, name));
      chmodSync(target, dirMode);
    } else {
      chmodSync(target, fileMode);
    }
  };
  walk(root);
}

beforeAll(async () => {
  provider = await serveFetch(async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === "/bilibili/validate-login-sync-v2") {
      const { token } = (await request.json()) as { token?: string };
      if (token?.startsWith("tok-alice-")) {
        return Response.json({ code: 0, data: { mid: 10001, uname: "爱丽丝", face: null } });
      }
      if (token?.startsWith("tok-bob-")) {
        return Response.json({ code: 0, data: { mid: 20002, uname: "鲍勃", face: null } });
      }
      return Response.json({ code: -101, message: "not logged in" });
    }

    if (pathname === "/alpha/decisions") {
      return Response.json({
        answers: {
          about_her: { type: "noul", noul: 1 },
          about_streams: { type: "noul", noul: 0 },
          recall_followup: { type: "noul", noul: 0 },
          asks_when: { type: "noul", noul: 0 },
          asks_frequency: { type: "noul", noul: 0 },
        },
      });
    }

    if (pathname === "/v1/embeddings") {
      const body = (await request.json()) as { input?: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? "")];
      // Every viewer's memories and queries share the exact same unit vector [1, 0, 0, 0]
      // (cosine similarity = 1.0), so vector distance never separates users: only Zvec's
      // inverted-index `user_id` filter prevents cross-viewer leakage.
      return Response.json({
        data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      });
    }

    if (pathname === "/v1/chat/completions") {
      const body = (await request.json()) as { stream?: boolean; messages: SentMessage[] };
      if (body.stream === true) {
        mindCalls.push({ messages: body.messages });
        const chunks = [
          { choices: [{ delta: { role: "assistant", content: "我记下啦！" } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.0001 } },
        ];
        const sse = [...chunks.map((c) => JSON.stringify(c)), "[DONE]"]
          .map((line) => `data: ${line}\n\n`)
          .join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }

      extractionCalls++;
      const prompt = body.messages.map((m) => String(m.content ?? "")).join("\n");
      const facts = prompt.includes("海鲜过敏")
        ? ["用户对海鲜过敏", "用户养了一只叫麻薯的猫"]
        : prompt.includes("冰美式")
          ? ["用户每天早上喝冰美式", "用户住在杭州"]
          : prompt.includes("榴莲")
            ? ["路人喜欢吃榴莲"]
            : [];
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ memory: facts.map((text) => ({ text })) }),
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      });
    }

    return new Response("not found", { status: 404 });
  });
});

afterAll(async () => {
  await provider.stop();
  resetSettings();
});

const ENV_KEYS = [
  "EIDOLON_HOME",
  "EIDOLON_CHAT_SECRET",
  "EIDOLON_REAL_IP_HEADER",
  "WORKERS_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_BASE",
  "MEM0_ENABLED",
  "MEM0_DIR",
  "MEM0_HISTORY_DB_PATH",
  "EMBED_DIM",
  "RERANK_ENABLED",
];

const savedEnv = new Map<string, string | undefined>();
let work = "";
let roHome = "";
let logs: CapturedLogs;
let bot: BotServer | null = null;

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  work = mkdtempSync(join(tmpdir(), "eidolon-prod-mem-"));
  roHome = join(work, "ro-data-home");
  const memVolume = join(work, "mem0-volume");
  mkdirSync(memVolume, { recursive: true, mode: 0o700 });

  const personaId = "milky-green";
  const indexDir = join(roHome, "personas", personaId, "index");
  mkdirSync(indexDir, { recursive: true, mode: 0o700 });
  const factText = "明前奶绿养了一只叫坚果的猫";
  await retrieval.writeTable(
    indexDir,
    "persona_facts",
    [
      {
        id: "fact-1",
        source: "facts.txt",
        date: "2026-05-09",
        floor: 1,
        text: factText,
        tokens: retrieval.tokenizeZh(factText),
      },
    ],
    retrieval.personaFactsSchema(4),
    Float32Array.from([1, 0, 0, 0]),
  );
  setTreeMode(roHome, 0o555, 0o444);

  process.env.EIDOLON_HOME = roHome;
  process.env.EIDOLON_CHAT_SECRET = SECRET;
  process.env.EIDOLON_REAL_IP_HEADER = IP_HEADER;
  process.env.WORKERS_BASE_URL = provider.url;
  process.env.OPENROUTER_API_KEY = "fake-key";
  process.env.OPENROUTER_API_BASE = `${provider.url}/v1`;
  process.env.MEM0_ENABLED = "true";
  process.env.MEM0_DIR = join(memVolume, "vectors");
  process.env.MEM0_HISTORY_DB_PATH = join(memVolume, "history.db");
  process.env.EMBED_DIM = "4";
  process.env.RERANK_ENABLED = "false";

  resetSettings();
  retrieval.resetEmbeddingModel();
  retrieval.resetRerankerCache();
  mindCalls.length = 0;
  extractionCalls = 0;
  logs = captureLogs();
});

afterEach(async () => {
  await bot?.stop();
  bot = null;
  memory.closeMemoryStores();
  retrieval.closeAllReadTables();
  logs.restore();
  if (roHome) setTreeMode(roHome, 0o700, 0o600);
  if (work) rmSync(work, { recursive: true, force: true });
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSettings();
});

async function bootProd(): Promise<string> {
  bot = await startBotServer(
    { host: "127.0.0.1", port: 0, verbose: 0 },
    {
      ...productionDeps(),
      access,
      memory,
      retrieval,
      turn: { iceServiceFromEnv },
      mcp: { createMcpHandler },
    },
  );
  return `http://127.0.0.1:${bot.server.port}`;
}

async function sendChatTurn(options: {
  base: string;
  chatId: string;
  persona: string;
  text: string;
  ip: string;
  loginSyncToken?: string;
}): Promise<void> {
  const header: ChatHeader = {
    format: CHAT_FORMAT,
    id: options.chatId,
    createdAt: 1000,
    participants: [options.persona],
  };
  const response = await fetch(`${options.base}/api/chat/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: ORIGIN,
      [IP_HEADER]: options.ip,
    },
    body: JSON.stringify({
      chat: { header, events: [] },
      text: options.text,
      ...(options.loginSyncToken ? { loginSyncToken: options.loginSyncToken } : {}),
    }),
  });
  expect(response.status).toBe(200);
  const lines = await linesOf(response);
  expect(eventsIn(lines).length).toBeGreaterThan(0);
}

interface ListedMemories {
  readonly user_id: string;
  readonly uname: string;
  readonly count: number;
  readonly memories: readonly { readonly id: string; readonly memory: string }[];
}

async function listMemories(base: string, token: string): Promise<ListedMemories> {
  const response = await fetch(`${base}/api/memories`, {
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ListedMemories;
}

async function waitForMemories(
  base: string,
  token: string,
  expectedCount: number,
): Promise<ListedMemories> {
  const deadline = performance.now() + 5000;
  for (;;) {
    const listed = await listMemories(base, token);
    if (listed.count === expectedCount) return listed;
    if (performance.now() >= deadline) return listed;
    await delay(15);
  }
}

describe("production multi-user memory isolation on Zvec", () => {
  test("isolates Alice, Bob, and anonymous viewers across chat turns, /api/memories, reopen, and forget", async () => {
    const suffix = ++tokenSuffix;
    const aliceToken = `tok-alice-${suffix}`;
    const bobToken = `tok-bob-${suffix}`;
    const badToken = `tok-bad-${suffix}`;
    const base = await bootProd();
    const persona = activePersona().id;

    expect((await fetch(`${base}/api/local/status`)).status).toBe(404);

    expect((await fetch(`${base}/api/memories`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/memories`, { headers: { Authorization: `Bearer ${badToken}` } }))
        .status,
    ).toBe(401);
    expect((await fetch(`${base}/api/memories/forget`, { method: "POST" })).status).toBe(401);

    await sendChatTurn({
      base,
      chatId: "0190f5c8-0000-7000-8000-00000000a101",
      persona,
      text: "我对海鲜过敏，还养了一只叫麻薯的猫",
      ip: "198.51.100.11",
      loginSyncToken: aliceToken,
    });
    const aliceInitial = await waitForMemories(base, aliceToken, 2);
    expect(aliceInitial.user_id).toBe("10001");
    expect(aliceInitial.uname).toBe("爱丽丝");
    expect(aliceInitial.memories.map((m) => m.memory).sort()).toEqual([
      "用户养了一只叫麻薯的猫",
      "用户对海鲜过敏",
    ]);

    await sendChatTurn({
      base,
      chatId: "0190f5c8-0000-7000-8000-00000000b201",
      persona,
      text: "我每天早上喝冰美式，住在杭州",
      ip: "198.51.100.22",
      loginSyncToken: bobToken,
    });
    const bobInitial = await waitForMemories(base, bobToken, 2);
    expect(bobInitial.user_id).toBe("20002");
    expect(bobInitial.uname).toBe("鲍勃");
    expect(bobInitial.memories.map((m) => m.memory).sort()).toEqual([
      "用户住在杭州",
      "用户每天早上喝冰美式",
    ]);

    const extractionsBeforeAnon = extractionCalls;
    const mindBeforeAnon = mindCalls.length;
    await sendChatTurn({
      base,
      chatId: "0190f5c8-0000-7000-8000-00000000c301",
      persona,
      text: "我其实是个路人，喜欢吃榴莲",
      ip: "198.51.100.33",
    });
    await sendChatTurn({
      base,
      chatId: "0190f5c8-0000-7000-8000-00000000c302",
      persona,
      text: "我还是路人，也喜欢吃榴莲",
      ip: "198.51.100.34",
      loginSyncToken: badToken,
    });
    await delay(60);
    expect(extractionCalls).toBe(extractionsBeforeAnon);
    for (const call of mindCalls.slice(mindBeforeAnon)) {
      const promptBlob = JSON.stringify(call.messages);
      expect(promptBlob).not.toContain("Based on previous conversations, I recall:");
      expect(promptBlob).not.toContain("海鲜过敏");
      expect(promptBlob).not.toContain("冰美式");
      // Persona RAG on the read-only EIDOLON_HOME still runs for anonymous viewers.
      expect(promptBlob).toContain("坚果");
    }

    memory.closeMemoryStores();

    const aliceTurnIndex = mindCalls.length;
    await sendChatTurn({
      base,
      chatId: "0190f5c8-0000-7000-8000-00000000a102",
      persona,
      text: "你还记得我的饮食禁忌和宠物吗？",
      ip: "198.51.100.11",
      loginSyncToken: aliceToken,
    });
    const alicePrompt = JSON.stringify(mindCalls[aliceTurnIndex]?.messages ?? []);
    expect(alicePrompt).toContain("Based on previous conversations, I recall:");
    expect(alicePrompt).toContain("用户对海鲜过敏");
    expect(alicePrompt).toContain("用户养了一只叫麻薯的猫");
    expect(alicePrompt).toContain("坚果");
    expect(alicePrompt).not.toContain("冰美式");
    expect(alicePrompt).not.toContain("杭州");
    expect(alicePrompt).not.toContain("榴莲");

    const bobTurnIndex = mindCalls.length;
    await sendChatTurn({
      base,
      chatId: "0190f5c8-0000-7000-8000-00000000b202",
      persona,
      text: "你还记得我喜欢喝什么、住在哪里吗？",
      ip: "198.51.100.22",
      loginSyncToken: bobToken,
    });
    const bobPrompt = JSON.stringify(mindCalls[bobTurnIndex]?.messages ?? []);
    expect(bobPrompt).toContain("Based on previous conversations, I recall:");
    expect(bobPrompt).toContain("用户每天早上喝冰美式");
    expect(bobPrompt).toContain("用户住在杭州");
    expect(bobPrompt).not.toContain("海鲜过敏");
    expect(bobPrompt).not.toContain("麻薯");
    expect(bobPrompt).not.toContain("榴莲");

    const t0 = performance.now();
    const forgetRes = await fetch(`${base}/api/memories/forget`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}`, Origin: ORIGIN },
    });
    const forgetMs = performance.now() - t0;
    expect(forgetRes.status).toBe(200);
    expect(await forgetRes.json()).toEqual({ ok: true, user_id: "10001" });
    expect(forgetMs).toBeLessThan(500);

    const aliceAfterForget = await listMemories(base, aliceToken);
    expect(aliceAfterForget).toEqual({
      user_id: "10001",
      uname: "爱丽丝",
      count: 0,
      memories: [],
    });

    const bobAfterAliceForget = await listMemories(base, bobToken);
    expect(bobAfterAliceForget.count).toBe(2);
    expect(bobAfterAliceForget.memories.map((m) => m.memory).sort()).toEqual([
      "用户住在杭州",
      "用户每天早上喝冰美式",
    ]);

    const alicePostForgetIndex = mindCalls.length;
    await sendChatTurn({
      base,
      chatId: "0190f5c8-0000-7000-8000-00000000a103",
      persona,
      text: "现在你还记得我什么吗？",
      ip: "198.51.100.11",
      loginSyncToken: aliceToken,
    });
    const alicePostForgetPrompt = JSON.stringify(mindCalls[alicePostForgetIndex]?.messages ?? []);
    expect(alicePostForgetPrompt).not.toContain("海鲜过敏");
    expect(alicePostForgetPrompt).not.toContain("麻薯");
    expect(alicePostForgetPrompt).not.toContain("冰美式");
    await delay(60);
  });
});
