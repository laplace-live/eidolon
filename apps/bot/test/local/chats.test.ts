// /api/local/chats over a fake turn, a fake director and a fake hearing: what the runner stores, in
// which order, and what each stream carries. The engine itself is never run here.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AllowedOffer } from "@eidolon/access";
import {
  type ChatEvent,
  type ChatEventDraft,
  type ChatEventOf,
  type ChatStreamLine,
  type ChatSummary,
  type ParticipantId,
  summarize,
  viewOf,
} from "@eidolon/chat";
import { activePersona, dataHome, readPersonaIdentity } from "@eidolon/config";
import { Director } from "@eidolon/context";
import {
  type ChatRequest,
  type EngineDeps,
  runChat,
  type TurnOutput,
  type TurnRequest,
} from "@eidolon/engine";
import { selfieStore } from "@eidolon/imagegen";
import {
  ProviderConfigError,
  ProviderHttpError,
  setUsageSink,
  type UsageRecord,
} from "@eidolon/providers";
import type { CallBinding, SignallingResult, SignallingServer } from "@eidolon/runtime";
import type { RouteHandler } from "../../src/app.ts";
import type { ChatContents } from "../../src/local/api.ts";
import {
  type ChatAnswer,
  type ChatHear,
  ChatRunner,
  type ChatRunnerOptions,
  type ChatTurn,
} from "../../src/local/chats/runner.ts";
import { identityHandlers } from "../../src/local/identity.ts";
import { createLocalRouter, type LocalApp, localRoute } from "../../src/local/router.ts";
import { chatRunner, chatsRoutes } from "../../src/local/routes/chats.ts";
import { ANSWER, type CapturedLogs, captureLogs, deferred } from "../fakes.ts";

const PERSONA = "milky-green";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const chatsRoot = () => join(dataHome(), "chats");

type Script = (request: TurnRequest, save: Parameters<ChatTurn>[1]) => AsyncIterable<TurnOutput>;

/**
 * What a request's turn does, by `<persona> <line>` or else `<line>`, the viewer's last line (""
 * for the greeting).
 */
let scripts: Map<string, Script>;
let requests: TurnRequest[];

const fakeTurn: ChatTurn = (request, save) => {
  requests.push(request);
  const last = request.chat.events.findLast(
    (event): event is ChatEventOf<"message"> =>
      event.type === "message" && event.speaker.kind === "user",
  );
  const line = request.kickoff ? "" : (last?.text ?? "");
  const script = scripts.get(`${request.persona} ${line}`) ?? scripts.get(line) ?? scripts.get("*");
  if (script === undefined) throw new Error(`no script for ${JSON.stringify(last?.text)}`);
  return script(request, save);
};

/** One decision of the fake director: who answers, in order. */
interface Hop {
  readonly replies: readonly ParticipantId[];
  readonly source: ChatEventOf<"decision">["source"];
  readonly scores?: Readonly<Record<string, number>>;
}

/**
 * The fake director's decisions by the viewer's line, each followed by its turns; "throw" throws
 * before any. The default is the chat's first persona alone. Like the engine's, each turn reads the
 * chat as stored.
 */
let plans: Map<string, readonly Hop[] | "throw">;
let answers: ChatRequest[];

const fakeAnswer: ChatAnswer = (request, save) => {
  answers.push(request);
  return (async function* () {
    const line = request.chat.events.find((event) => event.seq === request.after);
    const text = line?.type === "message" ? line.text : "";
    const { participants } = summarize(request.chat.header, request.chat.events);
    const plan = plans.get(text) ?? [
      {
        replies: participants.slice(0, 1),
        source: participants.length > 1 ? "fallback" : "single",
      },
    ];
    if (plan === "throw") throw new Error("the chain fell over");
    for (const hop of plan) {
      if (request.signal.aborted) return;
      yield {
        type: "decision",
        after: request.after,
        replies: hop.replies.map((persona) => ({ persona, mode: "text" }) as const),
        source: hop.source,
        ...(hop.scores ? { scores: hop.scores } : {}),
      };
      for (const persona of hop.replies) {
        if (request.signal.aborted) return;
        const chat = await request.read();
        const { viewer, signal, late } = request;
        yield* fakeTurn({ chat, persona, viewer, signal, ...(late ? { late } : {}) }, save);
      }
    }
  })();
};

type HearRequest = Parameters<ChatHear>[0];

/** What the fake hearing hears in a request's clip; it may wait, or throw. */
let hearing: (request: HearRequest) => Promise<{ text: string; durationMs?: number }>;
let heard: HearRequest[];

/** As the engine's: hears the clip, then saves it, as the viewer's voice message. */
const fakeHear: ChatHear = async (request, save) => {
  heard.push(request);
  const { text, durationMs } = await hearing(request);
  const audio = await save(request.clip.bytes, request.clip.mime);
  return {
    type: "message",
    id: crypto.randomUUID(),
    speaker: { kind: "user" },
    text,
    modality: "voice",
    attachments: [durationMs === undefined ? audio : { ...audio, durationMs }],
  };
};

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

interface ReplyOptions {
  /** Waited for after the first delta. */
  readonly hold?: Promise<void>;
  /** Waits for the abort after the first delta. */
  readonly untilAborted?: boolean;
  readonly attach?: boolean;
}

/** Her reply `text`, streamed in two deltas; an aborted reply keeps the first. */
function reply(text: string, options: ReplyOptions = {}): Script {
  return async function* (request, save) {
    const turn = crypto.randomUUID();
    const persona = request.persona;
    yield { type: "started", turn, persona };
    if (request.kickoff) {
      yield { type: "events", events: [{ type: "kickoff", persona, turn, content: "打个招呼" }] };
    }
    const half = text.slice(0, Math.ceil(text.length / 2));
    yield { type: "delta", turn, text: half };
    if (options.untilAborted) await aborted(request.signal);
    await options.hold;
    const said = request.signal.aborted ? half : text;
    const attachments = options.attach ? [await save(PNG, "image/png")] : undefined;
    yield {
      type: "events",
      events: [
        {
          type: "message",
          id: crypto.randomUUID(),
          speaker: { kind: "persona", id: persona },
          text: said,
          ...(attachments ? { attachments } : {}),
          ...(request.signal.aborted ? { interrupted: true } : {}),
        },
      ],
    };
    yield { type: "ended", turn };
  };
}

/**
 * Her reply that takes a selfie and is interrupted while it renders. The render runs on until
 * `photo` resolves, then brings its result and the photo, or nothing once the chat cancels it.
 */
function selfie(photo: Promise<void>): Script {
  return async function* (request, save) {
    const turn = crypto.randomUUID();
    const persona = request.persona;
    const speaker = { kind: "persona", id: persona } as const;
    yield { type: "started", turn, persona };
    yield { type: "delta", turn, text: "等我" };
    yield {
      type: "events",
      events: [
        { type: "tool-call", persona, turn, callId: "c1", name: "take_selfie", arguments: {} },
      ],
    };
    await aborted(request.signal);
    const late = request.late as NonNullable<TurnRequest["late"]>;
    const brought = async (): Promise<ChatEventDraft[]> => {
      await Promise.race([photo, aborted(late.signal)]);
      if (late.signal.aborted) return [];
      const attachment = await save(PNG, "image/png");
      return [
        { type: "tool-result", persona, turn, callId: "c1", result: { ok: true, count: 1 } },
        { type: "message", id: crypto.randomUUID(), speaker, text: "", attachments: [attachment] },
      ];
    };
    late.add("take_selfie", brought());
    yield {
      type: "events",
      events: [
        { type: "message", id: crypto.randomUUID(), speaker, text: "等我", interrupted: true },
      ],
    };
    yield { type: "ended", turn };
  };
}

interface Offered {
  readonly admission: AllowedOffer;
  readonly binding: CallBinding | undefined;
}

/** The fake signalling server's offers, each with the call it binds, and what it answers. */
let offered: Offered[];
let answer: SignallingResult;

const signalling: Pick<SignallingServer, "offer"> = {
  offer: async (admission, binding) => {
    offered.push({ admission, binding });
    return answer;
  },
};

interface ChatsServer {
  call(method: string, path: string, body?: unknown): Promise<Response>;
  /** A request as `init` makes it: a raw body, or headers of its own. */
  raw(method: string, path: string, init?: RequestInit): Promise<Response>;
  /** POST /api/offer with `body`, as the local offer route answers it. */
  offer(body: Record<string, unknown>): Promise<Response>;
  /** Runs the stop hooks, as the server's shutdown does. */
  shutdown(): Promise<void>;
  close(): Promise<void>;
}

function serveChats(
  options: ChatRunnerOptions = { turn: fakeTurn, answer: fakeAnswer, hear: fakeHear },
): ChatsServer {
  const stops: (() => Promise<void>)[] = [];
  const app: LocalApp = {
    port: () => 0,
    activeCalls: () => 0,
    restart: () => {},
    onStop: (hook) => {
      stops.push(hook);
    },
    memoryAdmin: () => null,
  };
  const chats = chatRunner(app, options);
  const router: RouteHandler = createLocalRouter(chatsRoutes(chats), () => "bearer");
  const identity = identityHandlers({ signalling, memoryAdmin: () => null, chats });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/api/local/*": router,
      "/api/offer": localRoute("POST", identity.offer, () => "bearer"),
    },
    fetch: () => new Response(null, { status: 404 }),
  });
  const base = `http://127.0.0.1:${server.port}/api/local`;
  const shutdown = async () => {
    for (const stop of stops.splice(0)) await stop();
  };
  return {
    offer: (body) =>
      fetch(`http://127.0.0.1:${server.port}/api/offer`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    call: (method, path, body) =>
      fetch(`${base}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              body: typeof body === "string" ? body : JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
      }),
    raw: (method, path, init) => fetch(`${base}${path}`, { ...init, method }),
    shutdown,
    async close() {
      await shutdown();
      await server.stop(true);
    },
  };
}

/** A stream's lines, read as far as a test asks. */
class Lines {
  readonly seen: ChatStreamLine[] = [];
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #done = false;

  constructor(response: Response) {
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    this.#reader = (response.body as ReadableStream<Uint8Array>).getReader();
  }

  /** Reads until a line passes `check`, returning it. */
  async until(check: (line: ChatStreamLine) => boolean): Promise<ChatStreamLine> {
    for (;;) {
      const found = this.seen.find(check);
      if (found !== undefined) return found;
      if (this.#done) throw new Error(`the stream ended without it: ${JSON.stringify(this.seen)}`);
      await this.#read();
    }
  }

  async all(): Promise<ChatStreamLine[]> {
    while (!this.#done) await this.#read();
    return this.seen;
  }

  async drop(): Promise<void> {
    await this.#reader.cancel();
  }

  async #read(): Promise<void> {
    const { done, value } = await this.#reader.read();
    if (done) {
      this.#done = true;
      return;
    }
    this.#buffer += this.#decoder.decode(value, { stream: true });
    const parts = this.#buffer.split("\n");
    this.#buffer = parts.pop() as string;
    for (const part of parts) this.seen.push(JSON.parse(part) as ChatStreamLine);
  }
}

/** The stream's lines with ids and times left out, and each events line as its types. */
function shape(lines: readonly ChatStreamLine[]): string[] {
  return lines.map((line) =>
    line.type === "events"
      ? `events ${line.events.map((event) => `${event.seq}:${event.type}`).join(",")}`
      : line.type === "delta"
        ? `delta ${line.text}`
        : line.type,
  );
}

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

let server: ChatsServer;
let logs: CapturedLogs;

beforeEach(() => {
  scripts = new Map([
    ["", reply("你好呀")],
    ["*", reply("收到啦")],
  ]);
  requests = [];
  plans = new Map();
  answers = [];
  hearing = async () => ({ text: "今天播什么？", durationMs: 2400 });
  heard = [];
  offered = [];
  answer = { status: 200, body: ANSWER };
  logs = captureLogs();
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  server = serveChats();
});

afterEach(async () => {
  await server.close();
  logs.restore();
  delete process.env.OPENROUTER_API_KEY;
  rmSync(chatsRoot(), { recursive: true, force: true });
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.json()) as T;
}

async function errorCode(response: Response): Promise<[number, string]> {
  const body = (await response.json()) as { error: { code: string } };
  return [response.status, body.error.code];
}

/** A chat with PERSONA whose greeting has finished. */
async function greeted(): Promise<string> {
  const { id } = await json<{ id: string }>(
    await server.call("POST", "/chats", { participants: [PERSONA] }),
    201,
  );
  await until(async () => (await server.call("GET", `/chats/${id}/live`)).status === 204);
  return id;
}

async function log(id: string): Promise<ChatContents> {
  return json(await server.call("GET", `/chats/${id}`));
}

/** Seven persona ids, PERSONA first: one more than a chat holds. */
const SEVEN = [PERSONA, "beta", "gamma", "delta", "epsilon", "zeta", "eta"];

/** Personas a test made, removed after it. */
const made: string[] = [];

/** Persona `id` in the data home, named `name` and `shortName`. */
function persona(id: string, name: string, shortName = name): void {
  const dir = join(dataHome(), "personas", id);
  made.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "persona.yaml"),
    `identity:\n  name: ${name}\n  shortName: ${shortName}\n`,
  );
}

/** A chat with PERSONA and `others`, which doesn't greet. */
async function group(...others: string[]): Promise<string> {
  const { id } = await json<{ id: string }>(
    await server.call("POST", "/chats", { participants: [PERSONA, ...others] }),
    201,
  );
  return id;
}

function messages(events: readonly ChatEvent[]): ChatEventOf<"message">[] {
  return events.filter((event): event is ChatEventOf<"message"> => event.type === "message");
}

function expectContiguous(events: readonly ChatEvent[]): void {
  expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => i + 1));
}

describe("a new chat", () => {
  test("greets: the kickoff turn runs at once, GET live streams it, and its events are stored", async () => {
    const hold = deferred();
    scripts.set("", reply("你好呀", { hold: hold.promise }));
    const { id } = await json<{ id: string }>(
      await server.call("POST", "/chats", { participants: [PERSONA] }),
      201,
    );
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    const live = new Lines(await server.call("GET", `/chats/${id}/live`));
    await live.until((line) => line.type === "delta");
    hold.resolve();
    expect(shape(await live.all())).toEqual([
      "started",
      "events 1:kickoff",
      "delta 你好",
      "events 2:message",
      "ended",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.kickoff).toBe(true);
    expect(requests[0]?.persona).toBe(PERSONA);
    expect(requests[0]?.viewer.isLoggedIn).toBe(true);
    expect(requests[0]?.chat.events).toEqual([]);

    const { header, events } = await log(id);
    expect(header).toMatchObject({ format: 1, id, participants: [PERSONA] });
    expectContiguous(events);
    expect(messages(events).map((m) => [m.speaker, m.text])).toEqual([
      [{ kind: "persona", id: PERSONA }, "你好呀"],
    ]);
    expect((await server.call("GET", `/chats/${id}/live`)).status).toBe(204);

    const list = await json<ChatSummary[]>(await server.call("GET", "/chats"));
    expect(list).toMatchObject([{ id, title: null, lastText: "你好呀", lastSeq: 2 }]);
  });

  test("greets in voice only when her reply mode is voice and her voice role can speak", async () => {
    const greet = async () => {
      const { id } = await json<{ id: string }>(
        await server.call("POST", "/chats", { participants: [PERSONA] }),
        201,
      );
      await new Lines(await server.call("GET", `/chats/${id}/live`)).all();
      return requests.at(-1)?.mode;
    };
    try {
      expect(await greet()).toBe("text");
      process.env.CHAT_REPLY_MODE = "voice";
      expect(await greet()).toBe("text");
      process.env.FISH_API_KEY = "fish-test";
      expect(await greet()).toBe("voice");
      process.env.CHAT_REPLY_MODE = "auto";
      expect(await greet()).toBe("text");
    } finally {
      delete process.env.CHAT_REPLY_MODE;
      delete process.env.FISH_API_KEY;
    }
  });

  test("is refused unless it names 1 to 6 personas that exist, each once", async () => {
    for (const id of SEVEN.slice(1)) persona(id, id.toUpperCase());
    for (const [body, want] of [
      [{ participants: [] }, [400, "bad-request"]],
      [{ participants: [PERSONA, PERSONA] }, [400, "bad-request"]],
      [{ participants: SEVEN }, [400, "bad-request"]],
      [{ participants: [7] }, [400, "bad-request"]],
      [{ participants: PERSONA }, [400, "bad-request"]],
      [{ participants: [PERSONA], title: "x" }, [400, "bad-request"]],
      [{ participants: ["Not A Slug"] }, [400, "invalid-persona-id"]],
      [{ participants: ["nobody-here"] }, [404, "unknown-persona"]],
      [{ participants: [PERSONA, "nobody-here"] }, [404, "unknown-persona"]],
      ["{", [400, "bad-json"]],
    ] as const) {
      expect([body, await errorCode(await server.call("POST", "/chats", body))]).toEqual([
        body,
        [...want],
      ]);
    }
    expect(existsSync(chatsRoot())).toBe(false);
  });

  test("is refused with missing-key while her mind has no key, and nothing is made", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const response = await server.call("POST", "/chats", { participants: [PERSONA] });
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect([response.status, body.error.code]).toEqual([409, "missing-key"]);
    expect(body.error.message).toStartWith("Her mind role has no key.");
    expect(body.error.message).toContain("OPENROUTER_API_KEY");

    persona("beta", "贝塔");
    const group = await server.call("POST", "/chats", { participants: [PERSONA, "beta"] });
    const named = (await group.json()) as { error: { code: string; message: string } };
    expect([group.status, named.error.code]).toEqual([409, "missing-key"]);
    expect(named.error.message).toStartWith(`${PERSONA}'s mind role has no key.`);
    expect(existsSync(chatsRoot())).toBe(false);
  });
});

describe("a message", () => {
  test("streams the viewer's line, the decision and the reply, each stored in order", async () => {
    const id = await greeted();
    const lines = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "  今天播什么？ " }),
    ).all();
    expect(shape(lines)).toEqual([
      "events 3:message",
      "events 4:decision",
      "started",
      "delta 收到",
      "events 5:message",
      "ended",
    ]);
    const { events } = await log(id);
    expectContiguous(events);
    // What each events line carried is what the log holds.
    const streamed = lines.flatMap((line) => (line.type === "events" ? line.events : []));
    expect(events.slice(2)).toEqual(streamed);
    expect(events[2]).toMatchObject({
      type: "message",
      speaker: { kind: "user" },
      text: "今天播什么？",
    });
    expect(events[3]).toMatchObject({
      type: "decision",
      after: 3,
      replies: [{ persona: PERSONA, mode: "text" }],
      source: "single",
    });
    // The answer read the log with the viewer's line in it.
    expect(answers).toHaveLength(1);
    expect(answers[0]?.after).toBe(3);
    expect(answers[0]?.chat.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(answers[0]?.viewer.isLoggedIn).toBe(true);
    // Her turn read it with the decision stored too.
    expect(requests[1]?.kickoff).toBeUndefined();
    expect(requests[1]?.chat.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);

    const tail = await json<ChatContents>(await server.call("GET", `/chats/${id}?afterSeq=3`));
    expect(tail.events.map((event) => event.seq)).toEqual([4, 5]);
  });

  test("interrupts a reply still streaming: her partial line, then the viewer's, then the new reply", async () => {
    const id = await greeted();
    scripts.set("第一句", reply("我想想看哦", { untilAborted: true }));
    const first = new Lines(await server.call("POST", `/chats/${id}/messages`, { text: "第一句" }));
    await first.until((line) => line.type === "delta");
    const second = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "第二句" }),
    ).all();
    expect(requests[1]?.signal.aborted).toBe(true);
    expect(shape(await first.all())).toEqual([
      "events 3:message",
      "events 4:decision",
      "started",
      "delta 我想想",
      "events 5:message",
      "ended",
    ]);
    expect(shape(second)).toEqual([
      "events 6:message",
      "events 7:decision",
      "started",
      "delta 收到",
      "events 8:message",
      "ended",
    ]);
    const { events } = await log(id);
    expectContiguous(events);
    expect(messages(events).map((m) => [m.speaker.kind, m.text, m.interrupted ?? false])).toEqual([
      ["persona", "你好呀", false],
      ["user", "第一句", false],
      ["persona", "我想想", true],
      ["user", "第二句", false],
      ["persona", "收到啦", false],
    ]);
  });

  test("a selfie her interrupted turn left running lands later, after the viewer's next line", async () => {
    const id = await greeted();
    const photo = deferred();
    scripts.set("发张自拍", selfie(photo.promise));
    const first = new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "发张自拍" }),
    );
    await first.until((line) => line.type === "delta");
    const second = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "快点嘛" }),
    ).all();
    expect(shape(await first.all())).toEqual([
      "events 3:message",
      "events 4:decision",
      "started",
      "delta 等我",
      "events 5:tool-call",
      "events 6:message",
      "ended",
    ]);
    expect(shape(second)).toEqual([
      "events 7:message",
      "events 8:decision",
      "started",
      "delta 收到",
      "events 9:message",
      "ended",
    ]);
    expect((await log(id)).lateTools).toEqual(["take_selfie"]);

    photo.resolve();
    await until(async () => (await log(id)).lateTools.length === 0);
    const { events } = await log(id);
    expectContiguous(events);
    expect(events.slice(9)).toMatchObject([
      { seq: 10, type: "tool-result", callId: "c1", result: { ok: true, count: 1 } },
      { seq: 11, type: "message", speaker: { kind: "persona" }, text: "" },
    ]);
    expect(
      messages(events).map((m) => [m.speaker.kind, m.text, m.interrupted ?? false, m.attachments]),
    ).toEqual([
      ["persona", "你好呀", false, undefined],
      ["user", "发张自拍", false, undefined],
      ["persona", "等我", true, undefined],
      ["user", "快点嘛", false, undefined],
      ["persona", "收到啦", false, undefined],
      ["persona", "", false, [{ kind: "image", name: expect.any(String), mime: "image/png" }]],
    ]);
    expect(requests[1]?.late?.signal.aborted).toBe(false);
  });

  test("stop leaves a selfie rendering, and delete cancels it", async () => {
    const id = await greeted();
    scripts.set("发张自拍", selfie(new Promise(() => {})));
    const posted = new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "发张自拍" }),
    );
    await posted.until((line) => line.type === "delta");
    expect((await server.call("POST", `/chats/${id}/stop`)).status).toBe(204);
    expect((await log(id)).lateTools).toEqual(["take_selfie"]);
    expect(requests[1]?.late?.signal.aborted).toBe(false);

    expect(await json(await server.call("DELETE", `/chats/${id}`))).toEqual({ ok: true });
    expect(requests[1]?.late?.signal.aborted).toBe(true);
    expect(existsSync(join(chatsRoot(), id))).toBe(false);
  });

  test("GET live replays the running turn from its start, and a dropped connection stops nothing", async () => {
    const id = await greeted();
    const hold = deferred();
    scripts.set("慢慢说", reply("好的好的", { hold: hold.promise }));
    const posted = new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "慢慢说" }),
    );
    await posted.until((line) => line.type === "delta");
    await posted.drop();

    const live = new Lines(await server.call("GET", `/chats/${id}/live`));
    await live.until((line) => line.type === "delta");
    expect(shape(live.seen)).toEqual([
      "events 3:message",
      "events 4:decision",
      "started",
      "delta 好的",
    ]);
    hold.resolve();
    expect(shape(await live.all()).slice(4)).toEqual(["events 5:message", "ended"]);
    expect(requests[1]?.signal.aborted).toBe(false);
    expect(messages((await log(id)).events).at(-1)).toMatchObject({ text: "好的好的" });
    expect(messages((await log(id)).events).at(-1)?.interrupted).toBeUndefined();
  });

  test("stop aborts the turn and answers once what it said is stored", async () => {
    const id = await greeted();
    scripts.set("停一下", reply("我还没说完呢", { untilAborted: true }));
    const posted = new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "停一下" }),
    );
    await posted.until((line) => line.type === "delta");
    const stopped = await server.call("POST", `/chats/${id}/stop`);
    expect(stopped.status).toBe(204);
    expect(messages((await log(id)).events).at(-1)).toMatchObject({
      text: "我还没",
      interrupted: true,
    });
    expect(shape(await posted.all()).at(-1)).toBe("ended");
    expect((await server.call("GET", `/chats/${id}/live`)).status).toBe(204);
    expect((await server.call("POST", `/chats/${id}/stop`)).status).toBe(204);
  });

  test("stop while a send is still storing the viewer's line stops the reply it starts", async () => {
    const runner = new ChatRunner({ root: chatsRoot(), turn: fakeTurn, answer: fakeAnswer });
    try {
      const id = await runner.create([PERSONA]);
      await runner.live(id)?.ended;
      const stored = deferred();
      const holding = deferred();
      const append = runner.store.append.bind(runner.store);
      runner.store.append = async (chat, events) => {
        if (events.some((event) => event.type === "message" && event.speaker.kind === "user")) {
          holding.resolve();
          await stored.promise;
        }
        return append(chat, events);
      };
      const sent = runner.send(id, "说吧");
      await holding.promise;
      const stopped = runner.stop(id);
      stored.resolve();
      await stopped;
      expect(answers.at(-1)?.signal.aborted).toBe(true);
      await (await sent).ended;
      const said = messages((await runner.read(id)).events);
      const asked = said.findLast((message) => message.speaker.kind === "user");
      expect(asked?.text).toBe("说吧");
      const after = said.filter((message) => message.seq > (asked?.seq ?? 0));
      expect(after.filter((message) => message.interrupted !== true)).toEqual([]);
    } finally {
      await runner.shutdown();
    }
  });

  test("a turn that throws is stored as turn-failed, and the chat stays usable", async () => {
    const id = await greeted();
    scripts.set("坏了", async function* (request) {
      yield { type: "started", turn: "t-1", persona: request.persona };
      throw new Error("the mind fell over");
    });
    const lines = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "坏了" }),
    ).all();
    expect(shape(lines)).toEqual([
      "events 3:message",
      "events 4:decision",
      "started",
      "events 5:turn-failed",
      "ended",
    ]);
    expect((await log(id)).events[4]).toMatchObject({
      type: "turn-failed",
      persona: PERSONA,
      turn: "t-1",
      error: "the mind fell over",
    });
    const next = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "再试一次" }),
    ).all();
    expect(shape(next).at(-2)).toBe("events 8:message");
  });

  test("is refused when its text, the chat or her key is wrong", async () => {
    const id = await greeted();
    const post = (text: unknown) => server.call("POST", `/chats/${id}/messages`, { text });
    expect(await errorCode(await post(""))).toEqual([400, "bad-request"]);
    expect(await errorCode(await post("   \n "))).toEqual([400, "bad-request"]);
    expect(await errorCode(await post("a".repeat(4001)))).toEqual([400, "bad-request"]);
    expect(await errorCode(await post("bell\u0007"))).toEqual([400, "bad-request"]);
    expect(await errorCode(await post(3))).toEqual([400, "bad-request"]);
    // 4000 code points, 8000 UTF-16 units.
    await new Lines(await post("😀".repeat(4000))).all();
    await new Lines(await post("两行\n也行")).all();

    const unknown = crypto.randomUUID();
    expect(
      await errorCode(await server.call("POST", `/chats/${unknown}/messages`, { text: "hi" })),
    ).toEqual([404, "unknown-chat"]);
    expect(
      await errorCode(await server.call("POST", "/chats/not-a-chat/messages", { text: "hi" })),
    ).toEqual([400, "bad-request"]);

    delete process.env.OPENROUTER_API_KEY;
    const before = (await log(id)).events.length;
    expect(await errorCode(await post("hi"))).toEqual([409, "missing-key"]);
    expect((await log(id)).events).toHaveLength(before);
  });
});

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6]);
const WEBM_NAME = `${new Bun.CryptoHasher("sha256").update(WEBM).digest("hex")}.webm`;

interface VoiceOptions {
  readonly bytes?: Uint8Array<ArrayBuffer>;
  readonly type?: string;
  /** `durationMs`, as sent; null sends none. */
  readonly ms?: string | null;
}

/** Sends chat `id` a voice message: WEBM, recorded as Chrome does, 2.5 s long. */
function voice(
  id: string,
  { bytes = WEBM, type = "audio/webm;codecs=opus", ms = "2500" }: VoiceOptions = {},
): Promise<Response> {
  return server.raw("POST", `/chats/${id}/voice${ms === null ? "" : `?durationMs=${ms}`}`, {
    body: bytes,
    headers: { "content-type": type },
  });
}

describe("a voice message", () => {
  beforeEach(() => {
    process.env.SONIOX_API_KEY = "soniox-test";
  });

  afterEach(() => {
    delete process.env.SONIOX_API_KEY;
  });

  test("stops the running reply, then is heard, stored with its audio and transcript, and answered", async () => {
    const id = await greeted();
    scripts.set("第一句", reply("我想想看哦", { untilAborted: true }));
    const first = new Lines(await server.call("POST", `/chats/${id}/messages`, { text: "第一句" }));
    await first.until((line) => line.type === "delta");
    const lines = await new Lines(await voice(id)).all();
    expect(shape(await first.all()).at(-2)).toBe("events 5:message");
    expect(shape(lines)).toEqual([
      "events 6:message",
      "events 7:decision",
      "started",
      "delta 收到",
      "events 8:message",
      "ended",
    ]);

    // Heard on the chat as stored once the reply it interrupted had kept what it said.
    expect(heard).toHaveLength(1);
    const [request] = heard as [HearRequest];
    expect(messages(request.chat.events).at(-1)).toMatchObject({
      text: "我想想",
      interrupted: true,
    });
    expect(new Uint8Array(request.clip.bytes)).toEqual(WEBM);
    expect(request.clip).toMatchObject({ mime: "audio/webm;codecs=opus", durationMs: 2500 });
    expect(request.signal.aborted).toBe(false);

    const { events } = await log(id);
    expectContiguous(events);
    expect(events[5]).toEqual({
      seq: 6,
      at: expect.any(Number),
      type: "message",
      id: expect.any(String),
      speaker: { kind: "user" },
      text: "今天播什么？",
      modality: "voice",
      attachments: [{ kind: "audio", name: WEBM_NAME, mime: "audio/webm", durationMs: 2400 }],
    });
    expect(answers.at(-1)?.after).toBe(6);
    expect(readdirSync(join(chatsRoot(), id, "files"))).toEqual([WEBM_NAME]);
  });

  test("heard as nothing is stored with an empty transcript, and still answered", async () => {
    const id = await greeted();
    hearing = async () => ({ text: "" });
    scripts.set(`${PERSONA} `, reply("没听清呢"));
    const lines = await new Lines(await voice(id, { type: "audio/mp4", ms: "120000" })).all();
    expect(shape(lines).slice(0, 2)).toEqual(["events 3:message", "events 4:decision"]);
    expect(messages((await log(id)).events).slice(1)).toMatchObject([
      { text: "", modality: "voice", attachments: [{ kind: "audio", mime: "audio/mp4" }] },
      { speaker: { kind: "persona", id: PERSONA }, text: "没听清呢" },
    ]);
  });

  test("a stop while it is heard stops the reply it starts", async () => {
    const id = await greeted();
    const hold = deferred();
    hearing = async () => {
      await hold.promise;
      return { text: "等一下" };
    };
    const posted = voice(id);
    await until(() => heard.length === 1);
    const stopped = server.call("POST", `/chats/${id}/stop`);
    hold.resolve();
    expect((await stopped).status).toBe(204);
    await new Lines(await posted).all();
    expect(answers.at(-1)?.signal.aborted).toBe(true);
    const said = messages((await log(id)).events);
    const asked = said.findLast((message) => message.speaker.kind === "user");
    expect(asked).toMatchObject({ text: "等一下", modality: "voice" });
    const after = said.filter((message) => message.seq > (asked?.seq ?? 0));
    expect(after.filter((message) => message.interrupted !== true)).toEqual([]);
  });

  test("a delete while it is heard cancels the hearing and removes the chat at once", async () => {
    const id = await greeted();
    hearing = async (request) => {
      await aborted(request.signal);
      throw request.signal.reason;
    };
    const posted = voice(id);
    await until(() => heard.length === 1);
    const deleted = await Promise.race([
      server.call("DELETE", `/chats/${id}`),
      Bun.sleep(1000).then(() => null),
    ]);
    expect(deleted).not.toBeNull();
    expect(await json(deleted as Response)).toEqual({ ok: true });
    expect((heard[0] as HearRequest).signal.aborted).toBe(true);
    expect((await posted).status).toBe(502);
    expect(existsSync(join(chatsRoot(), id))).toBe(false);
  });

  test("one that can't be heard stores nothing: 502, or 409 for her settings", async () => {
    const id = await greeted();
    const before = (await log(id)).events;
    hearing = async () => {
      throw new ProviderHttpError("Soniox", 500, "the transcriber fell over");
    };
    const failed = await voice(id);
    const body = (await failed.json()) as {
      error: { code: string; message: string; id: string };
    };
    expect([failed.status, body.error.code]).toEqual([502, "upstream-failed"]);
    expect(body.error.message).not.toContain("fell over");
    const logged = logs.records.find((record) => record.message.includes(body.error.id));
    expect(String(logged?.error)).toContain("the transcriber fell over");

    hearing = async () => {
      throw new ProviderConfigError("Soniox needs an API key: set SONIOX_API_KEY");
    };
    const refused = await voice(id);
    const why = (await refused.json()) as { error: { code: string; message: string } };
    expect([refused.status, why.error.code]).toEqual([409, "missing-key"]);
    expect(why.error.message).toContain("SONIOX_API_KEY");

    expect((await log(id)).events).toEqual(before);
    expect(existsSync(join(chatsRoot(), id, "files"))).toBe(false);
    expect((await json<ChatSummary[]>(await server.call("GET", "/chats")))[0]?.lastSeq).toBe(2);
  });

  test("is refused, unheard, when its audio, the chat or a key is wrong", async () => {
    const id = await greeted();
    const refusals: [VoiceOptions, [number, string]][] = [
      [{ type: "audio/wav" }, [415, "unsupported-media-type"]],
      [{ type: "video/webm" }, [415, "unsupported-media-type"]],
      [{ type: "application/json" }, [415, "unsupported-media-type"]],
      [{ ms: null }, [400, "bad-request"]],
      [{ ms: "0" }, [400, "bad-request"]],
      [{ ms: "-1" }, [400, "bad-request"]],
      [{ ms: "1.5" }, [400, "bad-request"]],
      [{ ms: "120001" }, [413, "payload-too-large"]],
      [{ bytes: new Uint8Array() }, [400, "bad-request"]],
      [{ bytes: new Uint8Array(10 * 1024 * 1024 + 1) }, [413, "payload-too-large"]],
    ];
    for (const [options, want] of refusals) {
      const { type, ms } = options;
      expect([type, ms, await errorCode(await voice(id, options))]).toEqual([type, ms, want]);
    }
    expect(await errorCode(await voice(crypto.randomUUID()))).toEqual([404, "unknown-chat"]);
    expect(await errorCode(await voice("not-a-chat"))).toEqual([400, "bad-request"]);

    delete process.env.SONIOX_API_KEY;
    const deaf = await voice(id);
    const body = (await deaf.json()) as { error: { code: string; message: string } };
    expect([deaf.status, body.error.code]).toEqual([409, "missing-key"]);
    expect(body.error.message).toStartWith("Her hearing role can't hear a voice message.");
    expect(body.error.message).toContain("SONIOX_API_KEY");
    expect((await log(id)).hearingRefusal).toBe(body.error.message);

    process.env.SONIOX_API_KEY = "soniox-test";
    expect((await log(id)).hearingRefusal).toBeNull();
    delete process.env.OPENROUTER_API_KEY;
    expect(await errorCode(await voice(id))).toEqual([409, "missing-key"]);

    expect(heard).toEqual([]);
    expect((await log(id)).events).toHaveLength(2);
  });

  test("a group's is heard by its first persona's hearing role", async () => {
    persona("beta", "贝塔");
    const id = await group("beta");
    delete process.env.SONIOX_API_KEY;
    const deaf = await voice(id);
    const body = (await deaf.json()) as { error: { code: string; message: string } };
    expect([deaf.status, body.error.code]).toEqual([409, "missing-key"]);
    expect(body.error.message).toStartWith(`${PERSONA}'s hearing role can't hear a voice message.`);
    expect((await log(id)).hearingRefusal).toBe(body.error.message);

    // One whose first persona was deleted since still reads, and refuses her.
    process.env.SONIOX_API_KEY = "soniox-test";
    const { id: led } = await json<{ id: string }>(
      await server.call("POST", "/chats", { participants: ["beta", PERSONA] }),
      201,
    );
    rmSync(join(dataHome(), "personas", "beta"), { recursive: true });
    expect((await log(led)).header.participants).toEqual(["beta", PERSONA]);
    expect(await errorCode(await voice(led))).toEqual([404, "unknown-persona"]);
  });

  test("is heard by default through the engine, on her hearing role's provider, as the chat's usage", async () => {
    const uploads: { auth: string | null; file: Uint8Array }[] = [];
    const openai = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/audio/transcriptions") {
          return new Response(null, { status: 404 });
        }
        const file = (await request.formData()).get("file") as File;
        uploads.push({
          auth: request.headers.get("authorization"),
          file: new Uint8Array(await file.arrayBuffer()),
        });
        return Response.json({ text: " 听得见吗 ", usage: { type: "duration", seconds: 2.4 } });
      },
    });
    process.env.STT_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-openai-test";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openai.port}/v1`;
    const usage: UsageRecord[] = [];
    setUsageSink((record) => usage.push(record));
    const engine = serveChats({ turn: fakeTurn, answer: fakeAnswer });
    try {
      const { id } = await json<{ id: string }>(
        await engine.call("POST", "/chats", { participants: [PERSONA] }),
        201,
      );
      await until(async () => (await engine.call("GET", `/chats/${id}/live`)).status === 204);
      const sent = await engine.raw("POST", `/chats/${id}/voice?durationMs=2500`, {
        body: WEBM,
        headers: { "content-type": "audio/webm;codecs=opus" },
      });
      await new Lines(sent).all();
      expect(uploads).toEqual([{ auth: "Bearer sk-openai-test", file: WEBM }]);
      const { events } = await json<ChatContents>(await engine.call("GET", `/chats/${id}`));
      expect(messages(events)[1]).toMatchObject({
        speaker: { kind: "user" },
        text: "听得见吗",
        modality: "voice",
        attachments: [{ kind: "audio", name: WEBM_NAME, mime: "audio/webm", durationMs: 2400 }],
      });
      expect(usage).toMatchObject([
        { role: "hearing", provider: "openai", source: "chat", session: id },
      ]);
    } finally {
      await engine.close();
      await openai.stop(true);
      setUsageSink(null);
      delete process.env.STT_PROVIDER;
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });

  test("its audio is served with its type, and in ranges for a player to seek", async () => {
    const id = await greeted();
    await new Lines(await voice(id)).all();
    const path = `/chats/${id}/files/${WEBM_NAME}`;

    const whole = await server.call("GET", path);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/webm");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
    expect(whole.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(WEBM);

    const part = await server.raw("GET", path, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(WEBM.slice(2, 6));

    const tail = await server.raw("GET", path, { headers: { range: "bytes=-3" } });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(WEBM.slice(7));

    const past = await server.raw("GET", path, { headers: { range: "bytes=10-" } });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */10");
  });
});

describe("a chat", () => {
  test("is renamed by a title event", async () => {
    const id = await greeted();
    const rename = (title: unknown) => server.call("PATCH", `/chats/${id}`, { title });
    expect(await json(await rename(" 周末计划 "))).toEqual({ ok: true });
    expect((await log(id)).events.at(-1)).toMatchObject({
      seq: 3,
      type: "title",
      title: "周末计划",
    });
    expect((await json<ChatSummary[]>(await server.call("GET", "/chats")))[0]?.title).toBe(
      "周末计划",
    );
    expect(await errorCode(await rename(""))).toEqual([400, "bad-request"]);
    expect(await errorCode(await rename("x".repeat(81)))).toEqual([400, "bad-request"]);
    expect(await errorCode(await rename("two\nlines"))).toEqual([400, "bad-request"]);
    expect(
      await errorCode(await server.call("PATCH", `/chats/${crypto.randomUUID()}`, { title: "hi" })),
    ).toEqual([404, "unknown-chat"]);
  });

  test("delete stops its turn and removes only its own folder", async () => {
    const keep = await greeted();
    scripts.set("", reply("等等", { untilAborted: true }));
    const { id } = await json<{ id: string }>(
      await server.call("POST", "/chats", { participants: [PERSONA] }),
      201,
    );
    writeFileSync(join(chatsRoot(), "notes.txt"), "not a chat");
    mkdirSync(join(dataHome(), "chats-elsewhere"), { recursive: true });
    const live = new Lines(await server.call("GET", `/chats/${id}/live`));
    await live.until((line) => line.type === "delta");

    expect(await json(await server.call("DELETE", `/chats/${id}`))).toEqual({ ok: true });
    expect(requests.at(-1)?.signal.aborted).toBe(true);
    expect(shape(await live.all()).at(-1)).toBe("ended");
    expect(readdirSync(chatsRoot()).toSorted()).toEqual([keep, "notes.txt"].toSorted());
    expect(existsSync(join(dataHome(), "chats-elsewhere"))).toBe(true);
    expect(await errorCode(await server.call("GET", `/chats/${id}`))).toEqual([
      404,
      "unknown-chat",
    ]);
    expect(await errorCode(await server.call("DELETE", `/chats/${id}`))).toEqual([
      404,
      "unknown-chat",
    ]);
    expect(
      (await json<ChatSummary[]>(await server.call("GET", "/chats"))).map((c) => c.id),
    ).toEqual([keep]);
  });

  test("is looked up only by a chat id", async () => {
    const unknown = crypto.randomUUID();
    for (const [method, path, want] of [
      ["GET", "/chats/NOT-A-UUID", [400, "bad-request"]],
      ["GET", `/chats/${unknown.toUpperCase()}`, [400, "bad-request"]],
      ["GET", "/chats/..%2F..%2Fsettings.yaml", [400, "bad-request"]],
      ["GET", `/chats/${unknown}`, [404, "unknown-chat"]],
      ["GET", `/chats/${unknown}?afterSeq=-1`, [400, "bad-request"]],
      ["GET", `/chats/${unknown}?afterSeq=x`, [400, "bad-request"]],
      ["GET", `/chats/${unknown}/live`, [404, "unknown-chat"]],
      ["POST", `/chats/${unknown}/stop`, [404, "unknown-chat"]],
      ["DELETE", "/chats/nope", [400, "bad-request"]],
    ] as const) {
      expect([method, path, await errorCode(await server.call(method, path))]).toEqual([
        method,
        path,
        [...want],
      ]);
    }
  });

  test("serves her selfie with its type, cached for good", async () => {
    scripts.set("", reply("看我", { attach: true }));
    const id = await greeted();
    const [message] = messages((await log(id)).events);
    const attachment = message?.attachments?.[0];
    expect(attachment).toMatchObject({ kind: "image", mime: "image/png" });
    const name = attachment?.name as string;
    expect(name).toBe(`${new Bun.CryptoHasher("sha256").update(PNG).digest("hex")}.png`);

    const file = await server.call("GET", `/chats/${id}/files/${name}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);

    const missing = await server.call("GET", `/chats/${id}/files/${"0".repeat(64)}.png`);
    expect(await errorCode(missing)).toEqual([404, "not-found"]);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    for (const bad of ["notes.txt", `${"0".repeat(64)}.svg`, "..%2Fchat.jsonl"]) {
      expect([bad, await errorCode(await server.call("GET", `/chats/${id}/files/${bad}`))]).toEqual(
        [bad, [400, "invalid-file-name"]],
      );
    }
  });
});

describe("a group chat", () => {
  test("doesn't greet, and stores no title, so the name the page gives it follows who is in it", async () => {
    persona("beta", "贝塔小姐", "贝塔");
    persona("gamma", "伽马");
    const id = await group("beta");
    expect((await server.call("GET", `/chats/${id}/live`)).status).toBe(204);
    expect(requests).toEqual([]);
    const { header, events } = await log(id);
    expect(header.participants).toEqual([PERSONA, "beta"]);
    expect(events).toEqual([]);
    await server.call("POST", `/chats/${id}/participants`, { add: ["gamma"], remove: ["beta"] });
    expect(await json<ChatSummary[]>(await server.call("GET", "/chats"))).toMatchObject([
      { id, title: null, participants: [PERSONA, "gamma"], lastText: null, lastSeq: 1 },
    ]);
  });

  test("answers a line hop by hop, storing each decision and turn before it streams", async () => {
    persona("beta", "贝塔");
    const id = await group("beta");
    plans.set("大家好", [
      { replies: [PERSONA, "beta"], source: "model", scores: { addressed_beta: 0.9 } },
      { replies: [PERSONA], source: "model", scores: { invites_reply: 0.7 } },
    ]);
    scripts.set(`${PERSONA} 大家好`, reply("奶绿来啦"));
    scripts.set("beta 大家好", reply("贝塔在呢"));
    const lines = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "大家好" }),
    ).all();
    expect(shape(lines)).toEqual([
      "events 1:message",
      "events 2:decision",
      "started",
      "delta 奶绿",
      "events 3:message",
      "ended",
      "started",
      "delta 贝塔",
      "events 4:message",
      "ended",
      "events 5:decision",
      "started",
      "delta 奶绿",
      "events 6:message",
      "ended",
    ]);
    const { events } = await log(id);
    expectContiguous(events);
    expect(events).toEqual(lines.flatMap((line) => (line.type === "events" ? line.events : [])));
    expect(events[1]).toMatchObject({
      type: "decision",
      after: 1,
      replies: [
        { persona: PERSONA, mode: "text" },
        { persona: "beta", mode: "text" },
      ],
      source: "model",
      scores: { addressed_beta: 0.9 },
    });
    expect(messages(events).map((m) => [m.speaker, m.text])).toEqual([
      [{ kind: "user" }, "大家好"],
      [{ kind: "persona", id: PERSONA }, "奶绿来啦"],
      [{ kind: "persona", id: "beta" }, "贝塔在呢"],
      [{ kind: "persona", id: PERSONA }, "奶绿来啦"],
    ]);
    expect(answers.map((answer) => answer.after)).toEqual([1]);
    expect(answers[0]?.chat.events.map((event) => event.seq)).toEqual([1]);
    // Each turn read the chat with every line before it stored.
    expect(requests.map((request) => request.chat.events.length)).toEqual([2, 3, 5]);
    expect((await server.call("GET", `/chats/${id}/live`)).status).toBe(204);
  });

  test("a new line interrupts the whole chain: her partial line is kept, and the hops after it dropped", async () => {
    persona("beta", "贝塔");
    const id = await group("beta");
    plans.set("聊聊天", [{ replies: [PERSONA, "beta"], source: "model" }]);
    scripts.set(`${PERSONA} 聊聊天`, reply("我先说两句", { untilAborted: true }));
    const first = new Lines(await server.call("POST", `/chats/${id}/messages`, { text: "聊聊天" }));
    await first.until((line) => line.type === "delta");
    const second = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "停一下" }),
    ).all();
    expect(answers[0]?.signal.aborted).toBe(true);
    expect(shape(await first.all())).toEqual([
      "events 1:message",
      "events 2:decision",
      "started",
      "delta 我先说",
      "events 3:message",
      "ended",
    ]);
    expect(shape(second)).toEqual([
      "events 4:message",
      "events 5:decision",
      "started",
      "delta 收到",
      "events 6:message",
      "ended",
    ]);
    expect(requests.map((request) => request.persona)).toEqual([PERSONA, PERSONA]);
    const { events } = await log(id);
    expectContiguous(events);
    expect(messages(events).map((m) => [m.text, m.interrupted ?? false])).toEqual([
      ["聊聊天", false],
      ["我先说", true],
      ["停一下", false],
      ["收到啦", false],
    ]);
  });

  test("a turn that throws is stored as that persona's turn-failed, and the chain goes no further", async () => {
    persona("beta", "贝塔");
    const id = await group("beta");
    plans.set("坏了", [{ replies: ["beta", PERSONA], source: "mention" }]);
    scripts.set("beta 坏了", async function* (request) {
      yield { type: "started", turn: "t-beta", persona: request.persona };
      throw new Error("the mind fell over");
    });
    const lines = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "坏了" }),
    ).all();
    expect(shape(lines)).toEqual([
      "events 1:message",
      "events 2:decision",
      "started",
      "events 3:turn-failed",
      "ended",
    ]);
    expect((await log(id)).events[2]).toMatchObject({
      type: "turn-failed",
      persona: "beta",
      turn: "t-beta",
      error: "the mind fell over",
    });
    expect(requests.map((request) => request.persona)).toEqual(["beta"]);
  });

  test("an answer that throws outside any turn ends its stream with an error, and the chat stays usable", async () => {
    persona("beta", "贝塔");
    const id = await group("beta");
    plans.set("出错", "throw");
    const lines = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "出错" }),
    ).all();
    expect(shape(lines)).toEqual(["events 1:message", "error"]);
    expect(lines.at(-1)).toMatchObject({ type: "error", code: "internal" });
    expect(logs.lines()).toContainEqual(expect.stringContaining("the reply failed"));
    expect((await log(id)).events.map((event) => event.type)).toEqual(["message"]);
    const next = await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "再来" }),
    ).all();
    expect(shape(next)).toEqual([
      "events 2:message",
      "events 3:decision",
      "started",
      "delta 收到",
      "events 4:message",
      "ended",
    ]);
  });

  test("adds and removes personas as participants events, keeping 1 to 6", async () => {
    for (const id of SEVEN.slice(1)) persona(id, id.toUpperCase());
    const id = await group("beta");
    const change = (body: unknown) => server.call("POST", `/chats/${id}/participants`, body);
    expect(await json(await change({ add: ["gamma"], remove: ["beta"] }))).toEqual({ ok: true });
    expect((await log(id)).events.at(-1)).toMatchObject({
      seq: 1,
      type: "participants",
      added: ["gamma"],
      removed: ["beta"],
    });
    expect(await json(await change({ remove: ["gamma"] }))).toEqual({ ok: true });
    expect((await log(id)).events.at(-1)).toEqual({
      seq: 2,
      at: expect.any(Number),
      type: "participants",
      removed: ["gamma"],
    });
    expect(await json(await change({ add: ["beta", "gamma"] }))).toEqual({ ok: true });
    expect(
      (await json<ChatSummary[]>(await server.call("GET", "/chats")))[0]?.participants,
    ).toEqual([PERSONA, "beta", "gamma"]);

    const before = (await log(id)).events.length;
    for (const [body, want] of [
      [{}, [400, "bad-request"]],
      [{ add: [] }, [400, "bad-request"]],
      [{ add: "delta" }, [400, "bad-request"]],
      [{ add: ["delta", "delta"] }, [400, "bad-request"]],
      [{ add: ["delta"], remove: ["delta"] }, [400, "bad-request"]],
      [{ add: ["delta"], title: "x" }, [400, "bad-request"]],
      [{ add: [PERSONA] }, [400, "bad-request"]],
      [{ remove: ["delta"] }, [400, "bad-request"]],
      [{ remove: [PERSONA, "beta", "gamma"] }, [400, "bad-request"]],
      [{ add: ["delta", "epsilon", "zeta", "eta"] }, [400, "bad-request"]],
      [{ add: ["Not A Slug"] }, [400, "invalid-persona-id"]],
      [{ add: ["nobody-here"] }, [404, "unknown-persona"]],
    ] as const) {
      expect([body, await errorCode(await change(body))]).toEqual([body, [...want]]);
    }
    expect((await log(id)).events).toHaveLength(before);
    expect(
      await errorCode(
        await server.call("POST", `/chats/${crypto.randomUUID()}/participants`, { add: ["delta"] }),
      ),
    ).toEqual([404, "unknown-chat"]);

    delete process.env.OPENROUTER_API_KEY;
    expect(await errorCode(await change({ add: ["delta"] }))).toEqual([409, "missing-key"]);
    expect(await json(await change({ remove: ["gamma"] }))).toEqual({ ok: true });
  });

  test("a persona deleted since is refused until she is removed from the chat", async () => {
    persona("beta", "贝塔");
    const id = await group("beta");
    rmSync(join(dataHome(), "personas", "beta"), { recursive: true });
    const post = () => server.call("POST", `/chats/${id}/messages`, { text: "还在吗" });
    expect(await errorCode(await post())).toEqual([404, "unknown-persona"]);
    expect((await log(id)).events).toHaveLength(0);
    expect(
      await json(await server.call("POST", `/chats/${id}/participants`, { remove: ["beta"] })),
    ).toEqual({ ok: true });
    expect(shape(await new Lines(await post()).all()).at(-2)).toBe("events 4:message");
  });

  test("the chain limit is kept as a settings event", async () => {
    const id = await greeted();
    const patch = (body: unknown) => server.call("PATCH", `/chats/${id}`, body);
    expect(await json(await patch({ chainLimit: 0 }))).toEqual({ ok: true });
    expect(await json(await patch({ chainLimit: 6 }))).toEqual({ ok: true });
    expect((await log(id)).events.slice(2)).toMatchObject([
      { seq: 3, type: "settings", chainLimit: 0 },
      { seq: 4, type: "settings", chainLimit: 6 },
    ]);
    for (const body of [
      { chainLimit: -1 },
      { chainLimit: 7 },
      { chainLimit: 1.5 },
      { chainLimit: "3" },
      { chainLimit: null },
      { chainLimit: 2, title: "x" },
      {},
    ]) {
      expect([body, await errorCode(await patch(body))]).toEqual([body, [400, "bad-request"]]);
    }
    expect((await log(id)).events).toHaveLength(4);
    expect(
      await errorCode(
        await server.call("PATCH", `/chats/${crypto.randomUUID()}`, { chainLimit: 1 }),
      ),
    ).toEqual([404, "unknown-chat"]);
  });

  test("the reply mode is kept as a settings event", async () => {
    const id = await greeted();
    const patch = (body: unknown) => server.call("PATCH", `/chats/${id}`, body);
    for (const replyMode of ["voice", "text", "auto"]) {
      expect(await json(await patch({ replyMode }))).toEqual({ ok: true });
    }
    expect((await log(id)).events.slice(2)).toMatchObject([
      { seq: 3, type: "settings", replyMode: "voice" },
      { seq: 4, type: "settings", replyMode: "text" },
      { seq: 5, type: "settings", replyMode: "auto" },
    ]);
    for (const body of [
      { replyMode: "Voice" },
      { replyMode: "audio" },
      { replyMode: null },
      { replyMode: "text", chainLimit: 2 },
    ]) {
      expect([body, await errorCode(await patch(body))]).toEqual([body, [400, "bad-request"]]);
    }
    expect((await log(id)).events).toHaveLength(5);
  });
});

test("the engine's runChat answers through the runner, each turn on the chat as stored", async () => {
  persona("beta", "贝塔");
  /** What each persona says, whatever she is asked. */
  const says: Record<string, string> = { [PERSONA]: "好呀", beta: "奶绿你说呢" };
  const deps: Omit<EngineDeps, "saveAttachment"> = {
    createMind: () => {
      const text = says[activePersona().id] ?? "";
      return {
        async *stream() {
          yield { type: "text", text };
          yield { type: "done", finishReason: "stop" };
        },
      };
    },
    parts: async () => ({
      systemInstruction: "SYSTEM",
      providers: [],
      gate: null,
      tools: [],
      memories: async () => [],
    }),
    fetchImage: () => Promise.reject(new Error("no images here")),
    newId: () => crypto.randomUUID(),
    speech: {
      canSpeak: () => false,
      synthesize: () => Promise.reject(new Error("no voice here")),
      transcribe: () => Promise.reject(new Error("no ears here")),
    },
  };
  const engine = serveChats({
    answer: (request, saveAttachment) =>
      runChat(request, { ...deps, saveAttachment, director: new Director(null) }),
  });
  try {
    const { id } = await json<{ id: string }>(
      await engine.call("POST", "/chats", { participants: [PERSONA, "beta"] }),
      201,
    );
    const lines = await new Lines(
      await engine.call("POST", `/chats/${id}/messages`, { text: "@贝塔 在吗" }),
    ).all();
    const { events } = await json<ChatContents>(await engine.call("GET", `/chats/${id}`));
    expectContiguous(events);
    expect(events).toEqual(lines.flatMap((line) => (line.type === "events" ? line.events : [])));
    // Beta answers the mention, Milky Green the name in Beta's line, and no one hers.
    expect(
      events.flatMap((event) =>
        event.type === "decision" ? [[event.after, event.replies.map((r) => r.persona)]] : [],
      ),
    ).toEqual([
      [1, ["beta"]],
      [3, [PERSONA]],
      [5, []],
    ]);
    expect(messages(events).map((m) => [m.speaker, m.text])).toEqual([
      [{ kind: "user" }, "@贝塔 在吗"],
      [{ kind: "persona", id: "beta" }, "奶绿你说呢"],
      [{ kind: "persona", id: PERSONA }, "好呀"],
    ]);
  } finally {
    await engine.close();
  }
});

test("shutdown aborts every turn and waits for what it said", async () => {
  const id = await greeted();
  scripts.set("别走", reply("我在呢我在呢", { untilAborted: true }));
  const posted = new Lines(await server.call("POST", `/chats/${id}/messages`, { text: "别走" }));
  await posted.until((line) => line.type === "delta");
  await server.shutdown();
  expect(shape(await posted.all()).at(-1)).toBe("ended");
  expect(messages((await log(id)).events).at(-1)).toMatchObject({
    text: "我在呢",
    interrupted: true,
  });
});

/** POST /api/offer's body, an SDP offer with `requestData` and any of `extra`'s fields. */
function offerBody(
  requestData: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { sdp: "v=0\r\n", type: "offer", requestData, ...extra };
}

/** Calls `who` in chat `id`, answered, and returns what the session was bound to. */
async function dial(id: string, who: string = PERSONA): Promise<CallBinding> {
  const response = await server.offer(
    offerBody({ audioQuality: "medium", chatId: id, persona: who }),
  );
  expect([response.status, await response.json()]).toEqual([200, ANSWER]);
  const binding = offered.at(-1)?.binding;
  if (binding === undefined) throw new Error("the offer wasn't bound to the chat");
  return binding;
}

describe("a call in a chat", () => {
  test("opens on her view of the chat, stores each finished line as a call message, and ends with call-ended", async () => {
    const id = await greeted();
    await new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "今天播什么" }),
    ).all();
    const binding = await dial(id);
    expect(binding.persona).toBe(PERSONA);
    expect(binding.seedMessages).toEqual([
      { role: "user", content: "打个招呼" },
      { role: "assistant", content: "你好呀" },
      { role: "user", content: "今天播什么" },
      { role: "assistant", content: "收到啦" },
    ]);
    expect(offered[0]?.admission).toMatchObject({
      user: { isLoggedIn: true },
      quota: null,
      requestData: { audioQuality: "medium", chatId: id, persona: PERSONA },
    });
    const during = await log(id);
    const call = during.call?.id as string;
    expect(during.call).toEqual({ id: call, persona: PERSONA });
    expect(during.events.at(-1)).toEqual({
      seq: 6,
      at: expect.any(Number),
      type: "call-started",
      call,
      persona: PERSONA,
    });
    expect(logs.lines()).toContain(
      `INFO [local] Offer from the local viewer to '${PERSONA}' in chat ${id} (call ${call})`,
    );

    const live = new Lines(await server.call("GET", `/chats/${id}/live`));
    binding.onTranscript({ role: "assistant", text: "喂？是你呀", interrupted: false });
    binding.onTranscript({ role: "user", text: "刚才说到哪了", interrupted: false });
    binding.onTranscript({ role: "assistant", text: "说到今天", interrupted: true });
    binding.onEnded("hangup");
    expect(shape(await live.all())).toEqual([
      "events 6:call-started",
      "events 7:message",
      "events 8:message",
      "events 9:message",
      "events 10:call-ended",
    ]);

    const after = await log(id);
    expectContiguous(after.events);
    expect(after.call).toBeNull();
    const at = expect.any(Number);
    const message = expect.any(String);
    const her = { kind: "persona", id: PERSONA } as const;
    expect(after.events.slice(6)).toEqual([
      {
        seq: 7,
        at,
        type: "message",
        id: message,
        speaker: her,
        text: "喂？是你呀",
        modality: "call",
      },
      {
        seq: 8,
        at,
        type: "message",
        id: message,
        speaker: { kind: "user" },
        text: "刚才说到哪了",
        modality: "call",
      },
      {
        seq: 9,
        at,
        type: "message",
        id: message,
        speaker: her,
        text: "说到今天",
        modality: "call",
        interrupted: true,
      },
      { seq: 10, at, type: "call-ended", call, reason: "hangup" },
    ]);
    expect((await server.call("GET", `/chats/${id}/live`)).status).toBe(204);
    expect((await json<ChatSummary[]>(await server.call("GET", "/chats")))[0]?.lastText).toBe(
      "说到今天",
    );

    // What the session reports once the call has ended changes nothing.
    binding.onTranscript({ role: "assistant", text: "再见", interrupted: false });
    binding.onEnded("error");
    await Bun.sleep(20);
    expect((await log(id)).events).toHaveLength(10);
    expect(logs.lines()).toContain(
      `WARNING Chat ${id}: her line came after call ${call} ended; dropped`,
    );
  });

  test("stops the running reply first, so the call opens on what she had said", async () => {
    const id = await greeted();
    scripts.set("讲个故事", reply("从前有座山", { untilAborted: true }));
    const posted = new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "讲个故事" }),
    );
    await posted.until((line) => line.type === "delta");
    const binding = await dial(id);
    expect(requests.at(-1)?.signal.aborted).toBe(true);
    expect(shape(await posted.all()).at(-1)).toBe("ended");
    expect((await log(id)).events.slice(-2)).toMatchObject([
      { type: "message", text: "从前有", interrupted: true },
      { type: "call-started", persona: PERSONA },
    ]);
    expect(binding.seedMessages.at(-1)).toEqual({ role: "assistant", content: "从前有" });
    binding.onEnded("hangup");
  });

  test("while it is on, a message, a voice message, a delete or another call is refused with chat-in-call", async () => {
    process.env.SONIOX_API_KEY = "soniox-test";
    try {
      const id = await greeted();
      const binding = await dial(id);
      expect(
        await errorCode(await server.call("POST", `/chats/${id}/messages`, { text: "在吗" })),
      ).toEqual([409, "chat-in-call"]);
      expect(await errorCode(await voice(id))).toEqual([409, "chat-in-call"]);
      expect(heard).toEqual([]);
      expect(await errorCode(await server.call("DELETE", `/chats/${id}`))).toEqual([
        409,
        "chat-in-call",
      ]);
      const again = await server.offer(offerBody({ chatId: id, persona: PERSONA }));
      expect(await errorCode(again)).toEqual([409, "chat-in-call"]);
      expect(offered).toHaveLength(1);
      expect((await server.call("POST", `/chats/${id}/stop`)).status).toBe(204);
      expect(requests).toHaveLength(1);
      expect((await log(id)).events.map((event) => event.type)).toEqual([
        "kickoff",
        "message",
        "call-started",
      ]);

      // Stored after the call-ended its end asked for first.
      binding.onEnded("hangup");
      const lines = await new Lines(
        await server.call("POST", `/chats/${id}/messages`, { text: "在吗" }),
      ).all();
      expect(shape(lines).slice(0, 2)).toEqual(["events 5:message", "events 6:decision"]);
      expect((await log(id)).events[3]).toMatchObject({ type: "call-ended", reason: "hangup" });
    } finally {
      delete process.env.SONIOX_API_KEY;
    }
  });

  test("queued behind a voice message when a delete comes, is refused: the delete wins", async () => {
    process.env.SONIOX_API_KEY = "soniox-test";
    try {
      const id = await greeted();
      hearing = async (request) => {
        await aborted(request.signal);
        throw request.signal.reason;
      };
      const posted = voice(id);
      await until(() => heard.length === 1);
      const dialled = server.offer(offerBody({ chatId: id, persona: PERSONA }));
      await Bun.sleep(20);
      const deleted = await server.call("DELETE", `/chats/${id}`);
      expect([deleted.status, await deleted.json()]).toEqual([200, { ok: true }]);
      expect((await posted).status).toBe(502);
      expect(await errorCode(await dialled)).toEqual([404, "unknown-chat"]);
      expect(offered).toEqual([]);
      expect(existsSync(join(chatsRoot(), id))).toBe(false);
    } finally {
      delete process.env.SONIOX_API_KEY;
    }
  });

  test("stopping a reply when a delete comes, is refused: the delete wins", async () => {
    const id = await greeted();
    const hold = deferred();
    scripts.set("讲个故事", reply("从前有座山", { untilAborted: true, hold: hold.promise }));
    const posted = new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "讲个故事" }),
    );
    await posted.until((line) => line.type === "delta");
    const dialled = server.offer(offerBody({ chatId: id, persona: PERSONA }));
    await until(() => requests.at(-1)?.signal.aborted === true);
    const deleted = server.call("DELETE", `/chats/${id}`);
    // The chat's cancel, which the delete aborts before it queues.
    await until(() => requests.at(-1)?.late?.signal.aborted === true);
    hold.resolve();
    expect(await errorCode(await dialled)).toEqual([404, "unknown-chat"]);
    const done = await deleted;
    expect([done.status, await done.json()]).toEqual([200, { ok: true }]);
    expect(offered).toEqual([]);
    expect(existsSync(join(chatsRoot(), id))).toBe(false);
  });

  test("a delete refused during it cancels nothing: a voice message after it is heard", async () => {
    process.env.SONIOX_API_KEY = "soniox-test";
    try {
      const id = await greeted();
      const binding = await dial(id);
      expect(await errorCode(await server.call("DELETE", `/chats/${id}`))).toEqual([
        409,
        "chat-in-call",
      ]);
      binding.onEnded("hangup");
      await new Lines(await voice(id)).all();
      expect(heard).toHaveLength(1);
      expect(heard[0]?.signal.aborted).toBe(false);
    } finally {
      delete process.env.SONIOX_API_KEY;
    }
  });

  test("is refused unless it names a chat and one of its personas, and nothing is stored", async () => {
    persona("beta", "贝塔");
    const id = await greeted();
    const unknown = Bun.randomUUIDv7();
    for (const [requestData, want] of [
      [{ chatId: "nope", persona: PERSONA }, [400, "bad-request"]],
      [{ chatId: id.toUpperCase(), persona: PERSONA }, [400, "bad-request"]],
      [{ chatId: 7, persona: PERSONA }, [400, "bad-request"]],
      [{ chatId: null, persona: PERSONA }, [400, "bad-request"]],
      [{ chatId: id }, [400, "bad-request"]],
      [{ chatId: id, persona: ["beta"] }, [400, "bad-request"]],
      [{ chatId: id, persona: "Not A Slug" }, [400, "invalid-persona-id"]],
      [{ chatId: id, persona: "nobody-here" }, [404, "unknown-persona"]],
      [{ chatId: unknown, persona: PERSONA }, [404, "unknown-chat"]],
      [{ chatId: id, persona: "beta" }, [400, "bad-request"]],
    ] as const) {
      const response = await server.offer(offerBody(requestData));
      expect([requestData, await errorCode(response)]).toEqual([requestData, [...want]]);
    }
    expect(offered).toEqual([]);
    expect((await log(id)).events).toHaveLength(2);
    expect(existsSync(join(chatsRoot(), unknown))).toBe(false);
  });

  test("without a chatId, the offer is the standalone call: unbound, and no chat hears of it", async () => {
    const id = await greeted();
    const response = await server.offer(offerBody({ audioQuality: "medium", persona: "beta" }));
    expect([response.status, await response.json()]).toEqual([200, ANSWER]);
    expect(offered).toHaveLength(1);
    expect(offered[0]?.binding).toBeUndefined();
    expect(offered[0]?.admission.requestData).toEqual({ audioQuality: "medium", persona: "beta" });
    expect(logs.lines()).toContain(
      `INFO [local] Offer from the local viewer to '${activePersona().id}'`,
    );
    const { events, call } = await log(id);
    expect([events.length, call]).toEqual([2, null]);
  });

  test("an offer that gets no answer ends the call it opened, with error", async () => {
    answer = { status: 400, body: { error: "invalid request" } };
    const id = await greeted();
    const response = await server.offer(offerBody({ chatId: id, persona: PERSONA }));
    expect([response.status, await response.json()]).toEqual([400, { error: "invalid request" }]);
    const { events, call } = await log(id);
    expect(call).toBeNull();
    expect(events.slice(2)).toMatchObject([
      { type: "call-started", persona: PERSONA },
      {
        type: "call-ended",
        reason: "error",
        call: (events[2] as ChatEventOf<"call-started">).call,
      },
    ]);
    expect((await server.call("GET", `/chats/${id}/live`)).status).toBe(204);
    (offered[0] as Offered).binding?.onEnded("hangup");
    await Bun.sleep(20);
    expect((await log(id)).events).toHaveLength(4);
  });

  test("the call's own connection renegotiating opens nothing; another connection is another call", async () => {
    const id = await greeted();
    const binding = await dial(id);
    const renegotiated = await server.offer(
      offerBody({ chatId: id, persona: PERSONA }, { pc_id: ANSWER.pc_id, restart_pc: true }),
    );
    expect([renegotiated.status, await renegotiated.json()]).toEqual([200, ANSWER]);
    expect(offered).toHaveLength(2);
    expect(offered[1]?.binding).toBeUndefined();
    const other = await server.offer(
      offerBody({ chatId: id, persona: PERSONA }, { pc_id: "SmallWebRTCConnection#1-other" }),
    );
    expect(await errorCode(other)).toEqual([409, "chat-in-call"]);
    expect(offered).toHaveLength(2);
    expect((await log(id)).events.map((event) => event.type)).toEqual([
      "kickoff",
      "message",
      "call-started",
    ]);
    binding.onEnded("hangup");
  });

  test("in a group, she calls as herself: her lines are hers, and the others read them later", async () => {
    persona("beta", "贝塔");
    const id = await group("beta");
    plans.set("大家好", [{ replies: [PERSONA], source: "model" }]);
    await new Lines(await server.call("POST", `/chats/${id}/messages`, { text: "大家好" })).all();
    const binding = await dial(id, "beta");
    expect(binding.persona).toBe("beta");
    expect(binding.seedMessages).toEqual([
      { role: "user", content: "观众：大家好" },
      { role: "user", content: `${readPersonaIdentity(PERSONA).name}：收到啦` },
    ]);
    binding.onTranscript({ role: "user", text: "贝塔你好", interrupted: false });
    binding.onTranscript({ role: "assistant", text: "你好呀", interrupted: false });
    binding.onEnded("hangup");
    await until(async () => (await log(id)).call === null);
    const { header, events } = await log(id);
    expect(messages(events).slice(-2)).toMatchObject([
      { speaker: { kind: "user" }, text: "贝塔你好", modality: "call" },
      { speaker: { kind: "persona", id: "beta" }, text: "你好呀", modality: "call" },
    ]);
    const nameOf = (who: string) => (who === "beta" ? "贝塔" : who);
    expect(viewOf(header, events, PERSONA, { windowMessages: 60, nameOf }).slice(-2)).toEqual([
      { role: "user", content: "观众：贝塔你好" },
      { role: "user", content: "贝塔：你好呀" },
    ]);
  });

  test("opens on a voice message heard as nothing as her turns read it", async () => {
    process.env.SONIOX_API_KEY = "soniox-test";
    try {
      const id = await greeted();
      hearing = async () => ({ text: "" });
      await new Lines(await voice(id)).all();
      const binding = await dial(id);
      expect(binding.seedMessages.slice(2, 3)).toEqual([{ role: "user", content: "（听不清）" }]);
      binding.onEnded("hangup");
    } finally {
      delete process.env.SONIOX_API_KEY;
    }
  });

  test("opens on her view less her tool calls and their results, keeping her context blocks", async () => {
    const id = await greeted();
    scripts.set("拍张照", async function* (request) {
      const turn = crypto.randomUUID();
      const persona = request.persona;
      yield { type: "started", turn, persona };
      yield {
        type: "events",
        events: [
          { type: "context", persona, turn, position: 2, role: "system", content: "猫叫坚果" },
          { type: "tool-call", persona, turn, callId: "c1", name: "take_selfie", arguments: {} },
          { type: "tool-result", persona, turn, callId: "c1", result: { ok: true } },
          {
            type: "message",
            id: crypto.randomUUID(),
            speaker: { kind: "persona", id: persona },
            text: "拍好啦",
          },
        ],
      };
      yield { type: "ended", turn };
    });
    await new Lines(await server.call("POST", `/chats/${id}/messages`, { text: "拍张照" })).all();
    const { header, events } = await log(id);
    expect(viewOf(header, events, PERSONA, { windowMessages: 60, nameOf: String })).toContainEqual({
      role: "tool",
      tool_call_id: "c1",
      content: '{"ok": true}',
    });
    const binding = await dial(id);
    expect(binding.seedMessages).toEqual([
      { role: "user", content: "打个招呼" },
      { role: "assistant", content: "你好呀" },
      { role: "system", content: "猫叫坚果" },
      { role: "user", content: "拍张照" },
      { role: "assistant", content: "拍好啦" },
    ]);
    binding.onEnded("hangup");
  });

  test("streams what an interrupted turn's selfie brings, as any event the chat stores meanwhile", async () => {
    const photo = deferred();
    const id = await greeted();
    scripts.set("拍张照", selfie(photo.promise));
    const posted = new Lines(
      await server.call("POST", `/chats/${id}/messages`, { text: "拍张照" }),
    );
    await posted.until((line) => line.type === "delta");
    const binding = await dial(id);
    await posted.all();
    const live = new Lines(await server.call("GET", `/chats/${id}/live`));
    photo.resolve();
    await live.until(
      (line) => line.type === "events" && line.events.some((event) => event.type === "tool-result"),
    );
    binding.onEnded("hangup");
    expect(shape(await live.all())).toEqual([
      "events 7:call-started",
      "events 8:tool-result,9:message",
      "events 10:call-ended",
    ]);
  });

  test("shutdown ends it, and the session's own end later changes nothing", async () => {
    const id = await greeted();
    const binding = await dial(id);
    binding.onTranscript({ role: "assistant", text: "要走了吗", interrupted: false });
    await server.shutdown();
    expect((await log(id)).events.slice(-2)).toMatchObject([
      { type: "message", text: "要走了吗", modality: "call" },
      { type: "call-ended", reason: "shutdown" },
    ]);
    binding.onEnded("hangup");
    await Bun.sleep(20);
    expect((await log(id)).events.at(-1)).toMatchObject({ type: "call-ended", reason: "shutdown" });
  });

  test("stores a photo she takes on it as her call message, in order with its lines", async () => {
    const id = await greeted();
    const binding = await dial(id);
    const url = selfieStore.publish({ data: PNG, mediaType: "image/png" }, 600);
    const live = new Lines(await server.call("GET", `/chats/${id}/live`));
    binding.onTranscript({ role: "assistant", text: "拍给你看", interrupted: false });
    binding.onServerMessage?.({ type: "selfie", urls: [url] });
    binding.onTranscript({ role: "assistant", text: "好看吗", interrupted: false });
    binding.onServerMessage?.({ type: "notice", urls: [url] });
    binding.onEnded("hangup");
    binding.onServerMessage?.({ type: "selfie", urls: [url] });
    expect(shape(await live.all())).toEqual([
      "events 3:call-started",
      "events 4:message",
      "events 5:message",
      "events 6:message",
      "events 7:call-ended",
    ]);
    const { events } = await log(id);
    const name = `${new Bun.CryptoHasher("sha256").update(PNG).digest("hex")}.png`;
    const her = { kind: "persona", id: PERSONA } as const;
    expect(events.slice(3).map(({ seq, at, ...event }) => event)).toEqual([
      { type: "message", id: expect.any(String), speaker: her, text: "拍给你看", modality: "call" },
      {
        type: "message",
        id: expect.any(String),
        speaker: her,
        text: "",
        attachments: [{ kind: "image", name, mime: "image/png" }],
        modality: "call",
      },
      { type: "message", id: expect.any(String), speaker: her, text: "好看吗", modality: "call" },
      { type: "call-ended", call: expect.any(String), reason: "hangup" },
    ]);
    const file = await server.call("GET", `/chats/${id}/files/${name}`);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
    expect(logs.lines()).toContain(
      `WARNING Chat ${id}: her photo came after call ${(events[2] as ChatEventOf<"call-started">).call} ended; dropped`,
    );
  });

  test("shutdown right after a hang-up waits for the call's last line and its end to be stored", async () => {
    const id = await greeted();
    const binding = await dial(id);
    binding.onTranscript({ role: "assistant", text: "拜拜", interrupted: false });
    binding.onEnded("hangup");
    await server.shutdown();
    // From the disk: a read through the store would wait for the appends itself.
    const stored = readFileSync(join(chatsRoot(), id, "chat.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ChatEvent);
    expect(stored.slice(-2)).toMatchObject([
      { type: "message", text: "拜拜", modality: "call" },
      { type: "call-ended", reason: "hangup" },
    ]);
  });
});
