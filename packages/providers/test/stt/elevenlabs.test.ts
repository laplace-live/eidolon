import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { setUsageSink, type UsageRecord } from "../../src/index.ts";
import { elevenLabsUrl, openElevenLabsStt } from "../../src/stt/elevenlabs.ts";
import {
  captureLogs,
  defaultSelection,
  errors,
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
  jest.useRealTimers();
  setUsageSink(null);
  server.stop();
  logs.restore();
});

const open = (language: string | null = "zh") =>
  openElevenLabsStt(selectionAt("elevenlabs", server.base), language, live());

const chunk = (audio: string, commit: boolean) =>
  `{"message_type": "input_audio_chunk", "audio_base_64": "${audio}", "commit": ${commit}, ` +
  '"sample_rate": 16000}';

test("connects where pipedog does, naming her language as ElevenLabs does", async () => {
  const selection = defaultSelection("elevenlabs", "ELEVENLABS_API_KEY");
  expect(elevenLabsUrl(selection, "zh")).toBe(
    "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime" +
      "&language_code=zho&audio_format=pcm_16000&commit_strategy=manual",
  );
  expect(elevenLabsUrl(selection, "en-US")).toContain("&language_code=eng&");
  expect(elevenLabsUrl(selection, "klingon")).toContain("&language_code=klingon&");
  expect(elevenLabsUrl(selection, null)).not.toContain("language_code");
  const stt = await open();
  const peer = await server.connection();
  expect(peer.url.pathname).toBe("/v1/speech-to-text/realtime");
  expect(peer.headers.get("xi-api-key")).toBe(KEY);
  expect([stt.inputRate, stt.ttfsP99, stt.acknowledgesFinalize]).toEqual([16000, 0.41, false]);
  await stt.close();
});

test("sends audio as base64 chunks, and finalize as an empty commit", async () => {
  const stt = await open();
  const peer = await server.connection();
  stt.send(new Int16Array([1, -2]));
  expect(await peer.next()).toBe(chunk("AQD+/w==", false));
  stt.finalize();
  expect(await peer.next()).toBe(chunk("", true));
  await stt.close();
});

test("partials are interim, commits are finalized segments, and errors are reported", async () => {
  const stt = await open();
  const events = watch(stt);
  const peer = await server.connection();
  peer.send({ message_type: "session_started", session_id: "s" });
  peer.send({ message_type: "partial_transcript", text: " 你好 " });
  peer.send({ message_type: "partial_transcript", text: "  " });
  peer.send({ message_type: "committed_transcript", text: "你好。" });
  peer.send({ message_type: "quota_exceeded", error: "out of credit" });
  peer.send({ message_type: "rate_limited" });
  await events.until((event) => event.type === "error" && event.message.includes("Unknown"));
  expect(events.seen).toEqual([
    { type: "interim", text: "你好" },
    { type: "final", text: "你好。", finalized: true },
    { type: "error", message: "Error: out of credit", fatal: false },
    { type: "error", message: "Error: Unknown error - rate_limited", fatal: false },
  ]);
  await stt.close();
});

test("sends 100 ms of silence once 10 s pass without audio", async () => {
  jest.useFakeTimers();
  const stt = await open();
  const peer = await server.connection();
  jest.advanceTimersByTime(5_000);
  stt.send(new Int16Array([3]));
  expect(await peer.next()).toBe(chunk("AwA=", false));
  jest.advanceTimersByTime(10_000);
  const silence = Buffer.alloc(3200).toString("base64");
  expect(await peer.next()).toBe(chunk(silence, false));
  await stt.close();
});

test("a refused key fails at once, and no error names it", async () => {
  server.refuse = 401;
  const stt = await open();
  const events = watch(stt);
  const failed = await events.until((event) => event.type === "error");
  expect(failed).toMatchObject({ fatal: true });
  expect(failed.type === "error" && failed.message).toStartWith(
    "Unable to connect to ElevenLabs Realtime STT: websocket connection to ws://127.0.0.1:",
  );
  expect(JSON.stringify(events.seen)).not.toContain(KEY);
  expect(errors(events.seen)).toHaveLength(1);
  await stt.close();
});

test("meters what it is sent", async () => {
  const records: UsageRecord[] = [];
  setUsageSink((record) => records.push(record));
  const stt = await open();
  stt.send(new Int16Array(16000));
  await stt.close();
  expect(records[0]).toMatchObject({
    role: "hearing",
    provider: "elevenlabs",
    model: "scribe_v2_realtime",
    units: { audioSeconds: 1 },
  });
});
