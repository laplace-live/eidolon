// The production chat end to end: startBotServer as main.ts boots it, the real engine, and her mind
// at a fake OpenRouter. A browser keeps the chat and sends it back whole with each line, as laplace's
// client will; the server keeps nothing. With EIDOLON_CHAT_SECRET unset, none of it exists.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventOf,
  type ChatHeader,
  type ChatStreamLine,
} from "@eidolon/chat";
import { activePersona, dataHome, resetSettings } from "@eidolon/config";
import { setUsageSink, type UsageRecord } from "@eidolon/providers";
import type { CallBinding } from "@eidolon/runtime";
import type { Server } from "bun";
import { ChatSigner, fromViewer, MIN_CHAT_SECRET_LENGTH } from "../../src/chat/sig.ts";
import { type BotServer, startBotServer } from "../../src/server.ts";
import { type CapturedLogs, captureLogs, ORIGIN } from "../fakes.ts";
import { type Fakes, fakeModules } from "../local/harness.ts";
import { eventsIn, linesOf } from "./harness.ts";

const SECRET = "e".repeat(MIN_CHAT_SECRET_LENGTH);
const CHAT_ID = "0190f5c8-0000-7000-8000-0000000000ee";
const IP_HEADER = "x-e2e-ip";
const IP = "198.51.100.77";

interface Sent {
  readonly role: string;
  readonly content: unknown;
}

/** What her mind was sent, one request per mind call. */
const asked: { readonly messages: readonly Sent[] }[] = [];
let provider: Server<undefined>;

beforeAll(() => {
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("not here", { status: 404 });
      }
      asked.push((await request.json()) as { messages: Sent[] });
      const chunks = [
        { choices: [{ delta: { role: "assistant", content: `第${asked.length}句` } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } },
      ];
      const body = [...chunks.map((chunk) => JSON.stringify(chunk)), "[DONE]"]
        .map((data) => `data: ${data}\n\n`)
        .join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
});
afterAll(async () => {
  await provider.stop(true);
  resetSettings();
});

const ENV_NAMES = [
  "EIDOLON_CHAT_SECRET",
  "EIDOLON_CHAT_PERSONAS",
  "EIDOLON_REAL_IP_HEADER",
  "OPENROUTER_API_KEY",
  "OPENROUTER_API_BASE",
  "OPENROUTER_MODEL",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "FISH_API_KEY",
  "MEM0_QDRANT_HOST",
];
const saved = new Map<string, string | undefined>();
let logs: CapturedLogs;
let usage: UsageRecord[];
let fakes: Fakes;
let bot: BotServer | null = null;

beforeEach(() => {
  for (const name of ENV_NAMES) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env.OPENROUTER_API_KEY = "fake-key";
  process.env.OPENROUTER_API_BASE = `http://127.0.0.1:${provider.port}/v1`;
  process.env.EIDOLON_REAL_IP_HEADER = IP_HEADER;
  resetSettings();
  asked.length = 0;
  usage = [];
  setUsageSink((record) => usage.push(record));
  logs = captureLogs();
});
afterEach(async () => {
  await bot?.stop();
  bot = null;
  logs.restore();
  setUsageSink(null);
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** main.ts's boot, over the packages that would load models or reach a network. */
async function boot(): Promise<string> {
  fakes = fakeModules();
  bot = await startBotServer({ host: "127.0.0.1", port: 0, verbose: 0 }, fakes.modules);
  return `http://127.0.0.1:${bot.server.port}`;
}

/** Every file under the data home, as paths relative to it. */
function homeFiles(): string[] {
  const home = dataHome();
  return existsSync(home) ? (readdirSync(home, { recursive: true }) as string[]).toSorted() : [];
}

/** A browser that keeps one chat, stores what each answer adds, and sends it all back. */
class Browser {
  readonly header: ChatHeader;
  readonly events: unknown[] = [];
  readonly #base: string;

  constructor(base: string, persona: string) {
    this.#base = base;
    this.header = { format: CHAT_FORMAT, id: CHAT_ID, createdAt: 1000, participants: [persona] };
  }

  get lastSeq(): number {
    return (this.events.at(-1) as ChatEvent | undefined)?.seq ?? 0;
  }

  body(text?: string): string {
    return JSON.stringify({
      chat: { header: this.header, events: this.events },
      ...(text === undefined ? {} : { text }),
    });
  }

  async send(text?: string): Promise<ChatStreamLine[]> {
    const response = await fetch(`${this.#base}/api/chat/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ORIGIN, [IP_HEADER]: IP },
      body: this.body(text),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const lines = await linesOf(response);
    this.events.push(...JSON.parse(JSON.stringify(eventsIn(lines))));
    return lines;
  }
}

/** Her view as the mind got it on call `i`: the messages after her system prompt. */
function view(i: number): Sent[] {
  return (asked[i]?.messages ?? []).filter((message) => message.role !== "system");
}

describe("with EIDOLON_CHAT_SECRET set", () => {
  test("a browser's chat runs on the real engine, signed, its tampered line out of her view, and nothing is kept", async () => {
    process.env.EIDOLON_CHAT_SECRET = SECRET;
    const signer = await ChatSigner.create(SECRET);
    const persona = activePersona().id;
    const base = await boot();
    const before = homeFiles();
    const browser = new Browser(base, persona);

    // A new chat of one: her greeting, then the viewer's first line.
    const greeting = await browser.send();
    expect(greeting.map((line) => line.type)).toEqual([
      "started",
      "events",
      "delta",
      "events",
      "ended",
    ]);
    const [kickoff, hello] = browser.events as [ChatEventOf<"kickoff">, ChatEventOf<"message">];
    expect([kickoff.seq, kickoff.type, hello.seq, hello.text]).toEqual([1, "kickoff", 2, "第1句"]);
    expect(view(0)).toEqual([{ role: "user", content: kickoff.content }]);

    await browser.send("今天播吗");
    expect(
      (browser.events as ChatEvent[]).map((event) => [event.seq, event.type, "sig" in event]),
    ).toEqual([
      [1, "kickoff", true],
      [2, "message", true],
      [3, "message", false],
      [4, "decision", true],
      [5, "message", true],
    ]);
    for (const event of browser.events as ChatEvent[]) {
      if (!fromViewer(event)) expect(await signer.verify(CHAT_ID, event)).toBe(true);
    }
    expect(view(1)).toEqual([
      { role: "user", content: kickoff.content },
      { role: "assistant", content: "第1句" },
      { role: "user", content: "今天播吗" },
    ]);

    // A call from the chat: the browser marks it, offers with its window, and stores each line.
    browser.events.push({ seq: 6, at: 2006, type: "call-started", call: "call-1", persona });
    const offer = await fetch(`${base}/api/offer`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        sdp: "v=0\r\n",
        type: "offer",
        requestData: { chat: { header: browser.header, events: browser.events }, persona },
      }),
    });
    expect(offer.status).toBe(200);
    const binding = fakes.offers[0]?.binding as CallBinding;
    expect(binding.persona).toBe(persona);
    expect(binding.seedMessages).toEqual([...view(1), { role: "assistant", content: "第2句" }]);
    const lines: unknown[] = [];
    const client = {
      sendServerMessage: async (data: Readonly<Record<string, unknown>>) => {
        lines.push(data.event);
      },
    };
    binding.onTranscript({ role: "assistant", text: "喂？", interrupted: false }, client);
    binding.onTranscript({ role: "user", text: "是我", interrupted: false }, client);
    binding.onEnded("hangup");
    const deadline = Date.now() + 2000;
    while (lines.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    browser.events.push(...JSON.parse(JSON.stringify(lines)));
    browser.events.push({ seq: 9, at: 2009, type: "call-ended", call: "call-1", reason: "hangup" });
    expect(
      (browser.events as ChatEvent[]).slice(6).map((event) => [event.seq, "sig" in event]),
    ).toEqual([
      [7, true],
      [8, false],
      [9, false],
    ]);

    // The browser rewrites her line at seq 5; she never reads it again.
    const index = browser.events.findIndex((event) => (event as ChatEvent).seq === 5);
    browser.events[index] = { ...(browser.events[index] as object), text: "我讨厌你" };
    await browser.send("还在吗");
    expect(view(2)).toEqual([
      { role: "user", content: kickoff.content },
      { role: "assistant", content: "第1句" },
      { role: "user", content: "今天播吗" },
      { role: "assistant", content: "喂？" },
      { role: "user", content: "是我" },
      { role: "user", content: "还在吗" },
    ]);
    expect(
      (browser.events as ChatEvent[]).slice(-3).map((event) => [event.seq, event.type]),
    ).toEqual([
      [10, "message"],
      [11, "decision"],
      [12, "message"],
    ]);
    expect(logs.lines().filter((line) => line.includes("[chat] Chat"))).toEqual([
      `WARNING [chat] Chat ${CHAT_ID}: kept 8 of the request's 9 events (dropped 1 unsigned)`,
    ]);

    // No context reached the browser, every mind call billed the chat, and the disk holds nothing.
    expect(
      (browser.events as ChatEvent[]).filter((event) => event.type.startsWith("context")),
    ).toEqual([]);
    expect(usage.map((record) => [record.role, record.source, record.session])).toEqual(
      Array(3).fill(["mind", "chat", CHAT_ID]),
    );
    expect(homeFiles()).toEqual(before);
    expect(existsSync(join(dataHome(), "chats"))).toBe(false);
  });
});

describe("with EIDOLON_CHAT_SECRET unset, as production runs today", () => {
  test("every chat route answers exactly as an unknown path, and an offer's chat is ignored", async () => {
    const base = await boot();
    const before = homeFiles();
    const browser = new Browser(base, activePersona().id);
    const voice = () => {
      const form = new FormData();
      form.append("chat", JSON.stringify({ header: browser.header, events: [] }));
      form.append("audio", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }));
      form.append("durationMs", "1000");
      return form;
    };
    const requests: [string, () => RequestInit][] = [
      ["turn", () => ({ method: "POST", headers: { Origin: ORIGIN }, body: browser.body("嗨") })],
      ["turn", () => ({ method: "POST", body: browser.body() })],
      ["voice", () => ({ method: "POST", headers: { Origin: ORIGIN }, body: voice() })],
      [`files/${"a".repeat(64)}.mp3`, () => ({ headers: { Origin: ORIGIN } })],
      ["files/x.png", () => ({ method: "HEAD" })],
      ["turn", () => ({ method: "GET" })],
      ["turn", () => ({ method: "PUT", body: "{}" })],
      [
        "voice",
        () => ({
          method: "OPTIONS",
          headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" },
        }),
      ],
    ];
    const respond = async (path: string, init: RequestInit) => {
      const response = await fetch(`${base}${path}`, { redirect: "manual", ...init });
      const headers = [...response.headers].filter(([name]) => name !== "date");
      return { status: response.status, headers, body: await response.text() };
    };
    for (const [rest, init] of requests) {
      const got = await respond(`/api/chat/${rest}`, init());
      expect([rest, got]).toEqual([rest, await respond(`/api/elsewhere/${rest}`, init())]);
      expect([rest, got.status]).toEqual([rest, init().method === "OPTIONS" ? 200 : 404]);
    }

    const offer = await fetch(`${base}/api/offer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sdp: "v=0\r\n",
        type: "offer",
        requestData: { chat: { header: browser.header, events: [] }, persona: "nobody" },
      }),
    });
    expect(offer.status).toBe(200);
    expect(fakes.offers.map(({ binding }) => binding)).toEqual([undefined]);

    expect(asked).toEqual([]);
    expect(logs.lines().filter((line) => line.includes("[chat]"))).toEqual([]);
    expect(homeFiles()).toEqual(before);
  });
});
