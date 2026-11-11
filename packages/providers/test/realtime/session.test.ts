import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolSchema } from "@eidolon/core";
import { setUsageSink, type UsageRecord } from "../../src/index.ts";
import { openRealtime, type RealtimeOptions } from "../../src/realtime/index.ts";
import { OPENAI } from "../../src/realtime/openai.ts";
import { openRealtimeSession } from "../../src/realtime/session.ts";
import { XAI } from "../../src/realtime/xai.ts";
import { captureLogs } from "../stt/fake.ts";
import {
  type DialectId,
  defaultRealtime,
  FakeRealtime,
  KEY,
  type RealtimePeer,
  realtimeAt,
  serverEvents,
  watch,
} from "./fake.ts";

const TOOLS: ToolSchema[] = [
  {
    name: "take_selfie",
    description: "Takes a selfie",
    properties: { scene: { type: "string" } },
    required: ["scene"],
  },
];

const VOICES: Readonly<Record<DialectId, string>> = { openai: "marin", xai: "eve" };

function options(dialect: DialectId, overrides: Partial<RealtimeOptions> = {}): RealtimeOptions {
  return {
    instructions: "Be her.",
    tools: TOOLS,
    voice: VOICES[dialect],
    transcription: dialect === "openai" ? { model: "gpt-realtime-whisper", language: "zh" } : null,
    signal: new AbortController().signal,
    ...overrides,
  };
}

let servers: FakeRealtime[] = [];
let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  setUsageSink(null);
  for (const server of servers) server.stop();
  servers = [];
  logs.restore();
});

function serve(dialect: DialectId, answers = true): FakeRealtime {
  const server = new FakeRealtime(dialect, { answers });
  servers.push(server);
  return server;
}

async function open(
  server: FakeRealtime,
  overrides: Partial<RealtimeOptions> = {},
  model?: string,
) {
  const session = await openRealtimeSession(
    realtimeAt(server.dialect, server.base, model),
    options(server.dialect, overrides),
  );
  const peer = await server.connection();
  return { session, peer, events: watch(session), says: serverEvents(server.dialect) };
}

/** Waits for whatever the session sent before this, then this: a marker in the send order. */
async function mark(session: { deleteItem(id: string): void }, peer: RealtimePeer, id = "mark") {
  session.deleteItem(id);
  return peer.nextOf("conversation.item.delete");
}

const withoutId = (raw: string) => raw.replace(/"event_id": "[0-9a-f-]{36}"/, '"event_id": "E"');

const TOOLS_JSON =
  '"tools": [{"type": "function", "name": "take_selfie", "description": "Takes a selfie", ' +
  '"parameters": {"type": "object", "properties": {"scene": {"type": "string"}}, "required": ["scene"]}}]';

test("dials pipedog's URL for each provider's own account, and the account's base otherwise", async () => {
  expect(OPENAI.url(defaultRealtime("openai"))).toBe(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
  );
  expect(XAI.url(defaultRealtime("xai"))).toBe(
    "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
  );
  expect(XAI.url(realtimeAt("xai", "https://proxy.test/x/v1/", "grok voice/2"))).toBe(
    "wss://proxy.test/x/v1/realtime?model=grok%20voice%2F2",
  );
  for (const dialect of ["openai", "xai"] as const) {
    const { session, peer } = await open(serve(dialect));
    expect(peer.url.pathname).toBe("/v1/realtime");
    expect(peer.url.searchParams.get("model")).toBe(
      dialect === "openai" ? "gpt-realtime-2.1" : "grok-voice-latest",
    );
    expect(peer.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect([session.inputRate, session.outputRate]).toEqual([
      dialect === "openai" ? 24000 : 16000,
      24000,
    ]);
    await session.close();
  }
});

test("OpenAI is configured once its session exists, as pipedog configured it", async () => {
  const { session, peer } = await open(serve("openai"));
  await peer.nextOf("session.update");
  expect(withoutId(peer.raw[0] as string)).toBe(
    '{"event_id": "E", "type": "session.update", "session": {"type": "realtime", ' +
      '"model": "gpt-realtime-2.1", "instructions": "Be her.", "audio": {"input": ' +
      '{"transcription": {"model": "gpt-realtime-whisper", "language": "zh"}}, ' +
      `"output": {"voice": "marin"}}, ${TOOLS_JSON}}}`,
  );
  await session.close();
  const detect = await open(serve("openai"), {
    transcription: { model: "gpt-realtime-whisper", language: null },
  });
  expect(await detect.peer.nextOf("session.update")).toMatchObject({
    session: { audio: { input: { transcription: { model: "gpt-realtime-whisper" } } } },
  });
  await detect.session.close();
});

test("xAI is configured once its conversation exists, with its audio formats", async () => {
  const { session, peer } = await open(serve("xai"));
  await peer.nextOf("session.update");
  expect(peer.raw).toHaveLength(1);
  expect(withoutId(peer.raw[0] as string)).toBe(
    '{"event_id": "E", "type": "session.update", "session": {"instructions": "Be her.", ' +
      '"voice": "eve", "turn_detection": {"type": "server_vad"}, "audio": {"input": {"format": ' +
      '{"type": "audio/pcm", "rate": 16000}}, "output": {"format": {"type": "audio/pcm", ' +
      `"rate": 24000}}}, ${TOOLS_JSON}}}`,
  );
  await session.close();
});

for (const dialect of ["openai", "xai"] as const) {
  describe(dialect, () => {
    test("holds items and the response until the session is ready, then sends them in order", async () => {
      const { session, peer, says } = await open(serve(dialect, false));
      await peer.nextOf("session.update");
      let sent: string | null = null;
      void session.addItem({ role: "system", text: "背景" }).then((id) => {
        sent = id;
      });
      session.createResponse();
      const kickoff = session.addItem({ role: "user", text: "Say hi." });
      session.deleteItem("old");
      await Bun.sleep(0);
      expect(sent).toBeNull();
      peer.send(says.sessionUpdated());
      const system = await peer.next();
      expect(system).toEqual({
        type: "conversation.item.create",
        item: {
          id: sent as unknown as string,
          type: "message",
          role: dialect === "openai" ? "system" : "user",
          content: [{ type: "input_text", text: "背景" }],
        },
      });
      expect(sent).toMatch(/^[0-9a-f]{32}$/);
      expect(peer.raw.at(-1)).toContain('"text": "\\u80cc\\u666f"');
      expect(await peer.next()).toMatchObject({ item: { id: await kickoff, role: "user" } });
      expect(await peer.next()).toEqual({ type: "conversation.item.delete", item_id: "old" });
      expect(await peer.next()).toEqual({
        type: "response.create",
        response:
          dialect === "openai"
            ? { output_modalities: ["audio"] }
            : { modalities: ["text", "audio"] },
      });
      await session.close();
    });

    test("one response at a time: a second is owed, and sent only for what came after the first", async () => {
      const { session, peer, events, says } = await open(serve(dialect));
      session.createResponse();
      await peer.nextOf("response.create");
      session.createResponse();
      peer.send(says.responseCreated("r1"), says.done("r1"));
      await events.until((event) => event.type === "response-done");
      // Nothing was delivered since: the first response took in what the second was for.
      expect(await mark(session, peer)).toMatchObject({ item_id: "mark" });

      session.createResponse();
      await peer.nextOf("response.create");
      // Typed text lands before the server has even acknowledged that create.
      void session.addItem({ role: "user", text: "And now?" });
      session.createResponse();
      peer.send(says.responseCreated("r2"), says.done("r2"));
      await peer.nextOf("conversation.item.create");
      expect(await peer.next()).toMatchObject({ type: "response.create" });

      // The user's turn drops what was owed, and so does a cancel.
      peer.send(says.responseCreated("r3"));
      await events.until((event) => event.type === "response-started" && event.responseId === "r3");
      void session.addItem({ role: "user", text: "x" });
      session.createResponse();
      peer.send(says.speechStarted("u1"), says.done("r3"));
      await events.until((event) => event.type === "response-done" && event.responseId === "r3");
      await peer.nextOf("conversation.item.create");
      expect(await mark(session, peer)).toMatchObject({ item_id: "mark" });

      peer.send(says.responseCreated("r4"));
      await events.until((event) => event.type === "response-started" && event.responseId === "r4");
      void session.addItem({ role: "user", text: "y" });
      session.createResponse();
      session.cancelResponse();
      peer.send(says.done("r4"));
      await events.until((event) => event.type === "response-done" && event.responseId === "r4");
      await peer.nextOf("response.cancel");
      expect(await mark(session, peer)).toMatchObject({ item_id: "mark" });
      await session.close();
    });

    test("a response the server started takes in what was delivered before it", async () => {
      const { session, peer, events, says } = await open(serve(dialect));
      await mark(session, peer, "ready");
      void session.addItem({ role: "system", text: "Recall: she sang yesterday." });
      peer.send(says.responseCreated("auto"));
      await events.until((event) => event.type === "response-started");
      session.createResponse();
      peer.send(says.done("auto"));
      await events.until((event) => event.type === "response-done");
      await peer.nextOf("conversation.item.create");
      expect(await mark(session, peer)).toMatchObject({ item_id: "mark" });
      await session.close();
    });

    test("speaks a response through several items, with its words and the user's", async () => {
      const { session, peer, events, says } = await open(serve(dialect));
      peer.send(
        says.speechStarted("u1"),
        ...says.heard("u1", ["你", "好"]),
        says.speechStopped("u1"),
        says.heardAll("u1", "你好。"),
        says.responseCreated("r1"),
        says.audio("r1", "a1", [1, -2]),
        says.spoken("r1", "a1", "嗨"),
        says.audio("r1", "a2", [3], 1),
        says.done("r1"),
      );
      await events.until((event) => event.type === "response-done");
      const seen = events.seen.map((event) =>
        event.type === "audio" ? { ...event, pcm: [...event.pcm] } : event,
      );
      expect(seen).toEqual([
        { type: "speech-started" },
        { type: "user-transcript", itemId: "u1", text: "你", final: false },
        { type: "user-transcript", itemId: "u1", text: "你好", final: false },
        { type: "speech-stopped" },
        { type: "user-transcript", itemId: "u1", text: "你好。", final: true },
        { type: "response-started", responseId: "r1" },
        { type: "audio", responseId: "r1", itemId: "a1", contentIndex: 0, pcm: [1, -2] },
        { type: "transcript-delta", responseId: "r1", itemId: "a1", text: "嗨" },
        { type: "audio", responseId: "r1", itemId: "a2", contentIndex: 1, pcm: [3] },
        { type: "response-done", responseId: "r1" },
      ]);
      await session.close();
    });

    test("runs a call the model announced, and answers it once", async () => {
      const { session, peer, events, says } = await open(serve(dialect));
      await mark(session, peer, "ready");
      peer.send(
        says.responseCreated("r1"),
        ...says.call("r1", "f1", "call_1", "take_selfie"),
        says.args("r1", "f1", "call_1", "take_selfie", '{"scene": "海边"}'),
        says.args("r1", "f2", "call_unknown", "take_selfie", "{}"),
        ...says.call("r1", "f3", "call_bad", "take_selfie"),
        says.args("r1", "f3", "call_bad", "take_selfie", "{oops"),
        says.done("r1"),
      );
      await events.until((event) => event.type === "response-done");
      expect(events.seen.filter((event) => event.type === "tool-call")).toEqual([
        { type: "tool-call", callId: "call_1", name: "take_selfie", arguments: { scene: "海边" } },
      ]);
      expect(logs.lines).toContain(
        "WARNING No tracked function call found for call_id: call_unknown",
      );
      session.sendToolOutput("call_1", '{"urls": ["https://x.test/1.png"]}');
      session.sendToolOutput("call_1", "CANCELLED");
      session.createResponse();
      expect(await peer.next()).toEqual({
        type: "conversation.item.create",
        item: {
          id: expect.stringMatching(/^[0-9a-f]{32}$/),
          type: "function_call_output",
          call_id: "call_1",
          output: '{"urls": ["https://x.test/1.png"]}',
        },
      });
      expect(await peer.next()).toMatchObject({ type: "response.create" });
      await session.close();
    });

    test("truncates, cancels and deletes as the API spells it", async () => {
      const { session, peer } = await open(serve(dialect));
      await mark(session, peer, "ready");
      session.truncate("a1", 0, 1234.7);
      session.cancelResponse();
      expect(await peer.next()).toEqual({
        type: "conversation.item.truncate",
        item_id: "a1",
        content_index: 0,
        audio_end_ms: 1234,
      });
      expect(await peer.next()).toEqual({ type: "response.cancel" });
      await session.close();
    });

    test("skips what it can't read, and the server's harmless refusals", async () => {
      const { session, peer, events, says } = await open(serve(dialect));
      peer.send(
        "not json",
        { no: "type" },
        { type: "output_audio_buffer.cleared", event_id: "e" },
        { type: "response.done", event_id: "e", response: { status: "completed" } },
        { type: "response.output_audio.delta", event_id: "e" },
        says.error("response_cancel_not_active", "Cancellation failed: no active response found"),
        says.error(
          "conversation_already_has_active_response",
          "Conversation already has an active response",
        ),
        says.speechStopped("u1"),
      );
      await events.until((event) => event.type === "speech-stopped");
      expect(events.seen).toEqual([
        { type: "response-done", responseId: "" },
        { type: "speech-stopped" },
      ]);
      expect(logs.lines.filter((line) => line.includes("Failed to parse"))).toHaveLength(2);
      await session.close();
    });

    test("a fatal error ends the session with pipedog's text", async () => {
      const { session, peer, events, says } = await open(serve(dialect));
      peer.send(says.error("server_error", "boom"), says.speechStarted("u1"));
      await events.ended;
      expect(events.seen).toEqual([
        {
          type: "error",
          message:
            dialect === "openai"
              ? 'Error: {"event_id":"ev_err","type":"error","error":{"type":"invalid_request_error",' +
                '"code":"server_error","message":"boom","param":null,"event_id":null}}'
              : "Grok Realtime Error: boom",
          fatal: true,
        },
      ]);
      await peer.closed;
      await session.close();
    });

    test("the socket closing under it is fatal", async () => {
      const { session, peer, events } = await open(serve(dialect));
      peer.close(1011, "overloaded");
      await events.ended;
      const name = dialect === "openai" ? "OpenAI Realtime" : "Grok Realtime";
      expect(events.seen).toEqual([
        {
          type: "error",
          message: `${name} connection closed, but with an error: 1011 overloaded`,
          fatal: true,
        },
      ]);
      const quiet = await open(serve(dialect));
      quiet.peer.close();
      await quiet.events.ended;
      expect(quiet.events.seen).toEqual([
        { type: "error", message: `${name} connection closed by the server`, fatal: true },
      ]);
      await session.close();
    });

    test("closing ends its events and settles what it held; aborting closes it", async () => {
      const { session, peer, events } = await open(serve(dialect, false));
      await peer.nextOf("session.update");
      const held = session.addItem({ role: "user", text: "never sent" });
      await session.close();
      await session.close();
      await events.ended;
      expect(await held).toMatch(/^[0-9a-f]{32}$/);
      expect(await session.addItem({ role: "user", text: "late" })).toMatch(/^[0-9a-f]{32}$/);
      expect(events.seen).toEqual([]);
      await peer.closed;

      const abort = new AbortController();
      const aborted = await open(serve(dialect), { signal: abort.signal });
      abort.abort();
      await aborted.events.ended;
      expect(aborted.events.seen).toEqual([]);
    });

    test("a refused handshake fails the open, and no error names the key", async () => {
      const server = serve(dialect);
      server.refuse = 401;
      const failed = await openRealtimeSession(
        realtimeAt(dialect, server.base),
        options(dialect),
      ).catch((error: Error) => error);
      expect(failed).toBeInstanceOf(Error);
      const prefix = dialect === "openai" ? "Error connecting: " : "Error connecting to Grok: ";
      expect((failed as Error).message).toStartWith(
        `${prefix}websocket connection to ws://127.0.0.1:`,
      );
      expect((failed as Error).message).toContain("/v1/realtime failed");
      expect((failed as Error).message).not.toContain(KEY);
      expect((failed as Error).message).not.toContain("model=");
    });
  });
}

test("OpenAI hears before it is ready; xAI drops audio until then", async () => {
  const openai = await open(serve("openai", false));
  await openai.peer.nextOf("session.update");
  openai.session.appendAudio(new Int16Array(0));
  openai.session.appendAudio(new Int16Array([1, -2]));
  expect(await openai.peer.next()).toEqual({
    type: "input_audio_buffer.append",
    audio: "AQD+/w==",
  });
  await openai.session.close();

  const xai = await open(serve("xai", false));
  await xai.peer.nextOf("session.update");
  xai.session.appendAudio(new Int16Array([1, -2]));
  xai.peer.send(serverEvents("xai").sessionUpdated());
  await mark(xai.session, xai.peer, "ready");
  xai.session.appendAudio(new Int16Array([3]));
  expect(await xai.peer.next()).toEqual({ type: "input_audio_buffer.append", audio: "AwA=" });
  expect(xai.peer.raw.filter((raw) => raw.includes("input_audio_buffer.append"))).toHaveLength(1);
  await xai.session.close();
});

test("OpenAI's interims are what the item has heard so far, each item its own", async () => {
  const { session, peer, events, says } = await open(serve("openai"));
  peer.send(
    ...says.heard("u1", ["我想", "问"]),
    ...says.heard("u2", ["再见"]),
    says.heardAll("u1", ""),
    ...says.heard("u1", ["新"]),
  );
  await events.until((event) => event.type === "user-transcript" && event.text === "新");
  expect(events.seen.map((event) => event.type === "user-transcript" && event.text)).toEqual([
    "我想",
    "我想问",
    "再见",
    "",
    "新",
  ]);
  await session.close();
});

test("xAI's transcripts come trimmed, and an empty one is dropped", async () => {
  const { session, peer, events, says } = await open(serve("xai"));
  peer.send(
    ...says.heard("u1", ["你", "好"]),
    says.heardAll("u1", "  "),
    says.heardAll("u2", " 好 "),
  );
  await events.until((event) => event.type === "user-transcript" && event.itemId === "u2");
  expect(events.seen).toEqual([
    { type: "user-transcript", itemId: "u1", text: "你", final: false },
    { type: "user-transcript", itemId: "u1", text: "你好", final: false },
    { type: "user-transcript", itemId: "u2", text: "好", final: true },
  ]);
  await session.close();
});

test("OpenAI reports each response's tokens, and nothing for a response without usage", async () => {
  const records: UsageRecord[] = [];
  setUsageSink((record) => records.push(record));
  const { session, peer, events, says } = await open(serve("openai"));
  peer.send(
    says.done("r1", { usage: { input: 100, cached: 40, output: 30 } }),
    { type: "response.done", event_id: "e", response: { id: "r2", status: "completed" } },
    says.done("r3", { status: "failed" }),
    says.done("r4", { status: "failed", details: { error: { message: "rate limited" } } }),
  );
  await events.until((event) => event.type === "response-done" && event.responseId === "r4");
  expect(
    records.map(({ role, provider, model, units }) => ({ role, provider, model, units })),
  ).toEqual([
    {
      role: "realtime",
      provider: "openai",
      model: "gpt-realtime-2.1",
      units: { inputTokens: 60, cachedTokens: 40, outputTokens: 30 },
    },
  ]);
  expect(events.seen.filter((event) => event.type === "response-done")).toEqual([
    { type: "response-done", responseId: "r1" },
    { type: "response-done", responseId: "r2" },
    { type: "response-done", responseId: "r3", error: "Response failed" },
    { type: "response-done", responseId: "r4", error: "rate limited" },
  ]);
  await session.close();
});

test("xAI's voice is metered by the hour it hears, else by its reported tokens", async () => {
  const records: UsageRecord[] = [];
  setUsageSink((record) => records.push(record));
  const hourly = await open(serve("xai"));
  hourly.session.appendAudio(new Int16Array(8000));
  hourly.session.appendAudio(new Int16Array(8000));
  hourly.peer.send(serverEvents("xai").done("r1", { usage: { input: 5, output: 5 } }));
  await hourly.events.until((event) => event.type === "response-done");
  expect(records).toEqual([]);
  await hourly.session.close();
  expect(records.map(({ role, model, units }) => ({ role, model, units }))).toEqual([
    { role: "realtime", model: "grok-voice-latest", units: { audioSeconds: 1 } },
  ]);

  records.length = 0;
  const { session, peer, events, says } = await open(serve("xai"), {}, "grok-voice-next");
  session.appendAudio(new Int16Array(16000));
  peer.send(
    says.done("r1", { usage: { input: 12, output: 8 } }),
    says.done("r2", { usage: { input: 0, output: 0 } }),
    says.done("r3", { status: "failed", details: { reason: "限流" } }),
  );
  await events.until((event) => event.type === "response-done" && event.responseId === "r3");
  await session.close();
  expect(records.map(({ units }) => units)).toEqual([
    { inputTokens: 12, cachedTokens: 0, outputTokens: 8 },
  ]);
  expect(events.seen.at(-1)).toEqual({
    type: "response-done",
    responseId: "r3",
    error: '{"reason": "\\u9650\\u6d41"}',
  });
});

test("opens the realtime role in scope, and refuses one without its key", async () => {
  const saved = { provider: process.env.REALTIME_PROVIDER, key: process.env.XAI_API_KEY };
  process.env.REALTIME_PROVIDER = "xai";
  process.env.XAI_API_KEY = "";
  try {
    const failed = await openRealtime(options("xai")).catch((error: Error) => error);
    expect((failed as Error).message).toBe(
      "xAI needs an API key: set XAI_API_KEY in credentials.json or the environment",
    );
  } finally {
    for (const [name, value] of [
      ["REALTIME_PROVIDER", saved.provider],
      ["XAI_API_KEY", saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
