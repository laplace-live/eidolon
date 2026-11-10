import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { setUsageSink, type UsageRecord } from "../../src/index.ts";
import { openSonioxStt, sonioxConfig, sonioxUrl } from "../../src/stt/soniox.ts";
import {
  captureLogs,
  defaultSelection,
  errors,
  FakeServer,
  KEY,
  live,
  samples,
  selectionAt,
  watch,
} from "./fake.ts";

const CONFIG =
  '{"model": "stt-rt-v5", "audio_format": "pcm_s16le", "num_channels": 1, ' +
  '"enable_endpoint_detection": false, "max_endpoint_delay_ms": null, ' +
  '"endpoint_sensitivity": null, "endpoint_latency_adjustment_level": null, ' +
  '"sample_rate": 16000, "language_hints": null, "language_hints_strict": null, ' +
  '"context": null, "enable_speaker_diarization": false, ' +
  '"enable_language_identification": false, "client_reference_id": null}';

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

const open = (signal = live()) => openSonioxStt(selectionAt("soniox", server.base), null, signal);

test("connects where pipedog does, with the key on the handshake and its config first", async () => {
  expect(sonioxUrl(defaultSelection("soniox", "SONIOX_API_KEY"))).toBe(
    "wss://stt-rt.soniox.com/transcribe-websocket",
  );
  const stt = await open();
  const peer = await server.connection();
  expect(peer.url.pathname).toBe("/transcribe-websocket");
  expect(peer.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(await peer.next()).toBe(CONFIG);
  expect([stt.inputRate, stt.ttfsP99]).toEqual([16000, 0.35]);
  await stt.close();
});

test("hints the base language, Bokmål as Norwegian, and none it doesn't know", () => {
  const hints = (language: string | null) =>
    JSON.parse(sonioxConfig("stt-rt-v5", language)).language_hints;
  expect(hints("en-US")).toEqual(["en"]);
  expect(hints("zh")).toEqual(["zh"]);
  expect(hints("nb-NO")).toEqual(["no"]);
  expect(hints("klingon")).toBeNull();
  expect(hints(null)).toBeNull();
});

test("sends audio as binary frames, and finalize as Soniox's message", async () => {
  const stt = await open();
  const peer = await server.connection();
  await peer.next();
  stt.send(new Int16Array([1, -2, 3]));
  expect(samples(await peer.next())).toEqual([1, -2, 3]);
  stt.finalize();
  expect(await peer.next()).toBe('{"type": "finalize"}');
  await stt.close();
});

test("final tokens stay interim text until an endpoint makes them one finalized segment", async () => {
  const stt = await open();
  const events = watch(stt);
  const peer = await server.connection();
  peer.send({
    tokens: [
      { text: "你", is_final: true },
      { text: "好", is_final: false },
    ],
  });
  peer.send({
    tokens: [
      { text: "好", is_final: true },
      { text: "<fin>", is_final: true },
      { text: "再", is_final: false },
    ],
  });
  // An endpoint with nothing before it says nothing.
  peer.send({ tokens: [{ text: "<fin>", is_final: true }] });
  peer.send({
    tokens: [
      { text: "见", is_final: true },
      { text: "<end>", is_final: true },
    ],
  });
  await events.until((event) => event.type === "final" && event.text === "见");
  expect(events.seen).toEqual([
    { type: "interim", text: "你好" },
    { type: "final", text: "你好", finalized: true },
    { type: "interim", text: "再" },
    { type: "final", text: "见", finalized: true },
  ]);
  await stt.close();
});

test("an error ends the segment; a rejected key is fatal, and never retried", async () => {
  const stt = await open();
  const events = watch(stt);
  const peer = await server.connection();
  peer.send({ tokens: [{ text: "嗯", is_final: true }], error_code: 503, error_message: "busy" });
  await events.until((event) => event.type === "error");
  peer.send({ tokens: [], error_code: 401, error_message: "Invalid API key" });
  peer.close();
  await events.until((event) => event.type === "error" && event.fatal);
  await Bun.sleep(50);
  expect(events.seen).toEqual([
    { type: "interim", text: "嗯" },
    { type: "final", text: "嗯", finalized: true },
    { type: "error", message: "Error: 503 (_receive_messages) - busy", fatal: false },
    { type: "error", message: "Error: 401 (_receive_messages) - Invalid API key", fatal: true },
  ]);
  expect(server.connections).toBe(1);
  await stt.close();
});

test("a dropped socket is reconnected at once, and configured again", async () => {
  const stt = await open();
  const events = watch(stt);
  const first = await server.connection();
  await first.next();
  first.close(1011, "boom");
  const second = await server.connection();
  expect(await second.next()).toBe(CONFIG);
  stt.send(new Int16Array([7]));
  expect(samples(await second.next())).toEqual([7]);
  expect(events.seen).toEqual([]);
  expect(logs.lines).toContain(
    "WARNING SonioxSTTService connection closed, but with an error: 1011 boom",
  );
  await stt.close();
});

test("three drops in a row right after connecting are fatal", async () => {
  server.onOpen = (peer) => peer.close();
  const stt = await open();
  const events = watch(stt);
  const failed = await events.until((event) => event.type === "error");
  expect(failed).toEqual({
    type: "error",
    message: "SonioxSTTService connection failed 3 times immediately after connecting",
    fatal: true,
  });
  expect(server.connections).toBe(3);
  await stt.close();
});

test("a server that stops answering is tried three times, 4 s apart, then given up on", async () => {
  jest.useFakeTimers();
  const stt = await open();
  const events = watch(stt);
  const peer = await server.connection();
  server.refuse = 503;
  peer.close();
  for (const attempt of [1, 2, 3]) {
    await events.until(
      (event) => event.type === "error" && event.message.includes(`attempt ${attempt} failed`),
    );
    jest.advanceTimersByTime(4_000);
  }
  await events.until((event) => event.type === "error" && event.fatal);
  const seen = errors(events.seen);
  expect(seen.map((event) => [event.fatal, event.type === "error" && event.message])).toEqual([
    [false, expect.stringMatching(/^Unable to connect to Soniox: .*503$/)],
    [false, expect.stringMatching(/^SonioxSTTService reconnection attempt 1 failed/)],
    [false, expect.stringMatching(/^Unable to connect to Soniox/)],
    [false, expect.stringMatching(/^SonioxSTTService reconnection attempt 2 failed/)],
    [false, expect.stringMatching(/^Unable to connect to Soniox/)],
    [false, expect.stringMatching(/^SonioxSTTService reconnection attempt 3 failed/)],
    [
      true,
      "SonioxSTTService failed to reconnect after 3 attempts: " +
        "SonioxSTTService websocket reconnection failed verification",
    ],
  ]);
  await stt.close();
});

test("a refused key fails at once, and no error names it", async () => {
  server.refuse = 401;
  const stt = await open();
  const events = watch(stt);
  const failed = await events.until((event) => event.type === "error");
  expect(failed).toMatchObject({ fatal: true });
  expect(failed.type === "error" && failed.message).toMatch(
    /^Unable to connect to Soniox: websocket connection to ws:\/\/127\.0\.0\.1:\d+\/transcribe-websocket failed.*401$/,
  );
  expect(JSON.stringify(events.seen)).not.toContain(KEY);
  await Bun.sleep(50);
  expect(errors(events.seen)).toHaveLength(1);
  await stt.close();
});

test("keeps an idle socket alive every 5 s, and only once it has been idle 1 s", async () => {
  jest.useFakeTimers();
  const stt = await open();
  const peer = await server.connection();
  await peer.next();
  jest.advanceTimersByTime(5_000);
  expect(await peer.next()).toBe('{"type": "keepalive"}');
  jest.advanceTimersByTime(4_500);
  stt.send(new Int16Array([1]));
  jest.advanceTimersByTime(500);
  expect(samples(await peer.next())).toEqual([1]);
  jest.advanceTimersByTime(5_000);
  expect(await peer.next()).toBe('{"type": "keepalive"}');
  await stt.close();
});

test("meters every second it is sent, and reports it once closed", async () => {
  const records: UsageRecord[] = [];
  setUsageSink((record) => records.push(record));
  const stt = await open();
  stt.send(new Int16Array(8000));
  stt.send(new Int16Array(8000));
  expect(records).toEqual([]);
  await stt.close();
  stt.send(new Int16Array(16000));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    role: "hearing",
    provider: "soniox",
    model: "stt-rt-v5",
    units: { audioSeconds: 1 },
  });
});

test("the call's signal closes it, and its events end", async () => {
  const call = new AbortController();
  const stt = await open(call.signal);
  const events = watch(stt);
  const peer = await server.connection();
  call.abort();
  await events.ended;
  await peer.closed;
  await stt.close();
});
