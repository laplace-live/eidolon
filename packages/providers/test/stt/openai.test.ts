import { afterEach, beforeEach, expect, test } from "bun:test";
import { setUsageSink, type UsageRecord } from "../../src/index.ts";
import { openaiSessionUpdate, openaiSttUrl, openOpenAIStt } from "../../src/stt/openai.ts";
import {
  captureLogs,
  defaultSelection,
  FakeServer,
  KEY,
  live,
  selectionAt,
  watch,
} from "./fake.ts";

let server: FakeServer;
let logs: ReturnType<typeof captureLogs>;
beforeEach(() => {
  server = new FakeServer();
  logs = captureLogs();
});
afterEach(() => {
  setUsageSink(null);
  server.stop();
  logs.restore();
});

const open = (language: string | null = "zh") =>
  openOpenAIStt(selectionAt("openai", `${server.base}/v1/`), language, live());

const SESSION_UPDATE =
  '{"type": "session.update", "session": {"type": "transcription", "audio": {"input": ' +
  '{"format": {"type": "audio/pcm", "rate": 24000}, "transcription": ' +
  '{"model": "gpt-realtime-whisper", "language": "zh"}, "turn_detection": null}}}}';

test("connects under the account's API base, with the key on the handshake", async () => {
  expect(openaiSttUrl(defaultSelection("openai", "OPENAI_API_KEY"))).toBe(
    "wss://api.openai.com/v1/realtime?intent=transcription",
  );
  const stt = await open();
  const peer = await server.connection();
  expect(`${peer.url.pathname}${peer.url.search}`).toBe("/v1/realtime?intent=transcription");
  expect(peer.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect([stt.inputRate, stt.ttfsP99, stt.acknowledgesFinalize]).toEqual([24000, 1.66, false]);
  await stt.close();
});

test("configures transcription once the session exists, in the base language", async () => {
  expect(openaiSessionUpdate("gpt-realtime-whisper", "zh-CN")).toBe(SESSION_UPDATE);
  expect(openaiSessionUpdate("gpt-realtime-whisper", null)).toContain(
    '"transcription": {"model": "gpt-realtime-whisper"}, ',
  );
  const stt = await open();
  const peer = await server.connection();
  peer.send({ type: "session.created", session: {} });
  expect(await peer.next()).toBe(SESSION_UPDATE);
  stt.send(new Int16Array([1, -2]));
  expect(await peer.next()).toBe('{"type": "input_audio_buffer.append", "audio": "AQD+/w=="}');
  stt.finalize();
  expect(await peer.next()).toBe('{"type": "input_audio_buffer.commit"}');
  await stt.close();
});

test("interims carry each segment's deltas so far, and its transcript is the final", async () => {
  const stt = await open();
  const events = watch(stt);
  const peer = await server.connection();
  const delta = (item_id: string, delta: string) => ({
    type: "conversation.item.input_audio_transcription.delta",
    item_id,
    delta,
  });
  peer.send(delta("a", "你"));
  peer.send(delta("a", "好"));
  peer.send(delta("b", "再"));
  peer.send({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "a",
    transcript: "你好。",
  });
  peer.send(delta("a", "见"));
  peer.send({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "b",
    error: { message: "too short" },
  });
  await events.until((event) => event.type === "error");
  expect(events.seen).toEqual([
    { type: "interim", text: "你" },
    { type: "interim", text: "你好" },
    { type: "interim", text: "再" },
    { type: "final", text: "你好。", finalized: false },
    { type: "interim", text: "见" },
    { type: "error", message: "OpenAI Realtime STT error: too short", fatal: false },
  ]);
  await stt.close();
});

test("a session error is reported, and the socket reconnected", async () => {
  const stt = await open();
  const events = watch(stt);
  const first = await server.connection();
  first.send({ type: "error", error: { code: "server_error", message: "oops" } });
  const second = await server.connection();
  second.send({ type: "session.created" });
  expect(await second.next()).toBe(SESSION_UPDATE);
  expect(events.seen).toEqual([
    { type: "error", message: "OpenAI Realtime STT error [server_error]: oops", fatal: false },
  ]);
  expect(logs.lines).toContain(
    "WARNING OpenAIRealtimeSTTService error receiving messages: " +
      "OpenAI Realtime STT error [server_error]: oops",
  );
  await stt.close();
});

test("a refused key fails at once, and no error names it", async () => {
  server.refuse = 403;
  const stt = await open();
  const events = watch(stt);
  const failed = await events.until((event) => event.type === "error");
  expect(failed).toMatchObject({ fatal: true });
  expect(failed.type === "error" && failed.message).toStartWith(
    "Error connecting to OpenAI Realtime STT: websocket connection to ws://127.0.0.1:",
  );
  expect(JSON.stringify(events.seen)).not.toContain(KEY);
  await stt.close();
});

test("meters 24 kHz audio by the second", async () => {
  const records: UsageRecord[] = [];
  setUsageSink((record) => records.push(record));
  const stt = await open();
  stt.send(new Int16Array(24000));
  await stt.close();
  expect(records[0]).toMatchObject({
    role: "hearing",
    provider: "openai",
    model: "gpt-realtime-whisper",
    units: { audioSeconds: 1 },
  });
});
