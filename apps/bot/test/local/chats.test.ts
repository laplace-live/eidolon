// /api/local/chats over a fake turn: what the runner stores, in which order, and what each stream
// carries. The engine itself is never run here.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ChatEvent,
  ChatEventDraft,
  ChatEventOf,
  ChatStreamLine,
  ChatSummary,
} from "@eidolon/chat";
import { dataHome } from "@eidolon/config";
import type { TurnOutput, TurnRequest } from "@eidolon/engine";
import type { RouteHandler } from "../../src/app.ts";
import type { ChatContents } from "../../src/local/api.ts";
import type { ChatTurn } from "../../src/local/chats/runner.ts";
import { createLocalRouter, type LocalApp } from "../../src/local/router.ts";
import { chatsRoutes } from "../../src/local/routes/chats.ts";
import { type CapturedLogs, captureLogs, deferred } from "../fakes.ts";

const PERSONA = "milky-green";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const chatsRoot = () => join(dataHome(), "chats");

type Script = (request: TurnRequest, save: Parameters<ChatTurn>[1]) => AsyncIterable<TurnOutput>;

/** What a request's turn does, by the viewer's last line ("" for the greeting). */
let scripts: Map<string, Script>;
let requests: TurnRequest[];

const fakeTurn: ChatTurn = (request, save) => {
  requests.push(request);
  const last = request.chat.events.findLast(
    (event): event is ChatEventOf<"message"> =>
      event.type === "message" && event.speaker.kind === "user",
  );
  const script = scripts.get(request.kickoff ? "" : (last?.text ?? "")) ?? scripts.get("*");
  if (script === undefined) throw new Error(`no script for ${JSON.stringify(last?.text)}`);
  return script(request, save);
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

interface ChatsServer {
  call(method: string, path: string, body?: unknown): Promise<Response>;
  /** Runs the stop hooks, as the server's shutdown does. */
  shutdown(): Promise<void>;
  close(): Promise<void>;
}

function serveChats(): ChatsServer {
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
  const router: RouteHandler = createLocalRouter(
    chatsRoutes(app, { turn: fakeTurn }),
    () => "bearer",
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: { "/api/local/*": router },
    fetch: () => new Response(null, { status: 404 }),
  });
  const base = `http://127.0.0.1:${server.port}/api/local`;
  const shutdown = async () => {
    for (const stop of stops.splice(0)) await stop();
  };
  return {
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
  logs = captureLogs();
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  server = serveChats();
});

afterEach(async () => {
  await server.close();
  logs.restore();
  delete process.env.OPENROUTER_API_KEY;
  rmSync(chatsRoot(), { recursive: true, force: true });
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

  test("is refused unless it names exactly one persona that exists", async () => {
    for (const [body, want] of [
      [{ participants: [] }, [400, "bad-request"]],
      [{ participants: [PERSONA, PERSONA] }, [400, "bad-request"]],
      [{ participants: [7] }, [400, "bad-request"]],
      [{ participants: [PERSONA], title: "x" }, [400, "bad-request"]],
      [{ participants: ["Not A Slug"] }, [400, "invalid-persona-id"]],
      [{ participants: ["nobody-here"] }, [404, "unknown-persona"]],
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
    expect(body.error.message).toContain("OPENROUTER_API_KEY");
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
    // The reply's turn read the log with the viewer's line in it.
    expect(requests[1]?.kickoff).toBe(false);
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
