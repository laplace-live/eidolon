import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { setUsageSink, type UsageRecord } from "../../src/index.ts";
import { deepgramUrl, openDeepgramStt } from "../../src/stt/deepgram.ts";
import {
  captureLogs,
  defaultSelection,
  errors,
  FakeServer,
  KEY,
  live,
  samples,
  selectionAt,
  turn,
  waitFor,
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
  openDeepgramStt(selectionAt("deepgram", server.base), language, live());

const results = (transcript: string, more: Record<string, unknown> = {}) => ({
  type: "Results",
  channel: { alternatives: [{ transcript }] },
  is_final: false,
  ...more,
});

test("connects where pipedog does, with its query, and the key on the handshake", async () => {
  const selection = defaultSelection("deepgram", "DEEPGRAM_API_KEY");
  expect(deepgramUrl(selection, "zh")).toBe(
    "wss://api.deepgram.com/v1/listen?detect_entities=false&diarize=false&dictation=false" +
      "&interim_results=true&numerals=false&punctuate=true&smart_format=false" +
      "&model=nova-3-general&language=zh&encoding=linear16&channels=1&multichannel=false" +
      "&sample_rate=16000",
  );
  expect(deepgramUrl(selection, null)).not.toContain("language=");
  const stt = await open();
  const peer = await server.connection();
  expect(peer.url.pathname).toBe("/v1/listen");
  expect(peer.url.searchParams.get("language")).toBe("zh");
  expect(peer.headers.get("authorization")).toBe(`Token ${KEY}`);
  expect([stt.inputRate, stt.ttfsP99]).toEqual([16000, 0.35]);
  await stt.close();
});

test("sends audio as binary frames, finalize as Finalize, and CloseStream on closing", async () => {
  const stt = await open();
  const peer = await server.connection();
  stt.send(new Int16Array([4, -5]));
  expect(samples(await peer.next())).toEqual([4, -5]);
  stt.finalize();
  expect(await peer.next()).toBe('{"type": "Finalize"}');
  await stt.close();
  expect(await peer.next()).toBe('{"type": "CloseStream"}');
});

test("a final is finalized only when it answers this turn's finalize", async () => {
  const stt = await open();
  const events = watch(stt);
  const peer = await server.connection();
  peer.send(results("你好"));
  peer.send(results("你好", { is_final: true }));
  const heard = (text: string) =>
    events.until((event) => event.type === "final" && event.text === text);
  stt.finalize();
  await peer.next();
  peer.send(results("吗", { is_final: true, from_finalize: true }));
  await heard("吗");
  // An empty answer passes the mark to the turn's next final, unless new words come first.
  stt.finalize();
  await peer.next();
  peer.send(results("", { is_final: true, from_finalize: true }));
  peer.send(results("晚了", { is_final: true }));
  await heard("晚了");
  stt.finalize();
  await peer.next();
  peer.send(results("", { is_final: true, from_finalize: true }));
  peer.send(results("新的"));
  peer.send(results("新的话", { is_final: true }));
  peer.send({ type: "Metadata" });
  await heard("新的话");
  expect(events.seen).toEqual([
    { type: "interim", text: "你好" },
    { type: "final", text: "你好", finalized: false },
    { type: "final", text: "吗", finalized: true },
    { type: "final", text: "晚了", finalized: true },
    { type: "interim", text: "新的" },
    { type: "final", text: "新的话", finalized: false },
  ]);
  await stt.close();
});

test("sends KeepAlive every 5 s, audio or not", async () => {
  jest.useFakeTimers();
  const stt = await open();
  const peer = await server.connection();
  stt.send(new Int16Array([1]));
  expect(samples(await peer.next())).toEqual([1]);
  jest.advanceTimersByTime(5_000);
  expect(await peer.next()).toBe('{"type": "KeepAlive"}');
  stt.send(new Int16Array([2]));
  jest.advanceTimersByTime(5_000);
  expect(samples(await peer.next())).toEqual([2]);
  expect(await peer.next()).toBe('{"type": "KeepAlive"}');
  await stt.close();
});

test("a rejected handshake gives up at once, and no error names the key", async () => {
  server.refuse = 401;
  const stt = await open();
  const events = watch(stt);
  const failed = await events.until((event) => event.type === "error");
  expect(failed).toMatchObject({ fatal: true });
  expect(failed.type === "error" && failed.message).toMatch(
    /^Deepgram rejected the connection \(status 401\): websocket connection to ws:\/\/127\.0\.0\.1:\d+\/v1\/listen failed/,
  );
  expect(JSON.stringify(events.seen)).not.toContain(KEY);
  expect(server.connections).toBe(0);
  await stt.close();
});

test("a dropped socket is reported and reconnected 4 s later", async () => {
  jest.useFakeTimers();
  const stt = await open();
  const events = watch(stt);
  const first = await server.connection();
  first.close(1011, "boom");
  await events.until((event) => event.type === "error");
  expect(events.seen).toEqual([{ type: "error", message: "1011 boom", fatal: false }]);
  // The backoff starts waiting once the closed socket is let go.
  await turn();
  jest.advanceTimersByTime(3_999);
  const next = server.connection();
  jest.advanceTimersByTime(1);
  const second = await next;
  // Words on the new socket: the client has it too.
  second.send(results("在"));
  await events.until((event) => event.type === "interim");
  stt.send(new Int16Array([9]));
  expect(samples(await second.next())).toEqual([9]);
  await stt.close();
});

test("three connections in a row that don't stay up are fatal", async () => {
  jest.useFakeTimers();
  server.onOpen = (peer) => peer.close(1011, "nope");
  // Opening may wait for a connection that stays, so its failures are counted in the log.
  const opening = open();
  const failures = () => logs.lines.filter((line) => line.startsWith("ERROR")).length;
  for (const attempt of [1, 2]) {
    await waitFor(() => failures() === attempt);
    await turn();
    jest.advanceTimersByTime(4_000);
  }
  const stt = await opening;
  const events = watch(stt);
  const failed = await events.until((event) => event.type === "error" && event.fatal);
  expect(failed.type === "error" && failed.message).toBe(
    "connection failed to stay up 3 times in a row",
  );
  expect(errors(events.seen)).toHaveLength(4);
  expect(server.connections).toBe(3);
  await stt.close();
});

test("a handshake refused by the server's trouble is retried 4 s later, and opening waits", async () => {
  jest.useFakeTimers();
  server.refuse = 503;
  let opened = false;
  const opening = open().then((stt) => {
    opened = true;
    return stt;
  });
  await waitFor(() => logs.lines.some((line) => line.includes("connection error:")));
  expect(opened).toBe(false);
  server.refuse = null;
  jest.advanceTimersByTime(4_000);
  const stt = await opening;
  const events = watch(stt);
  await server.connection();
  await events.until((event) => event.type === "error");
  expect(errors(events.seen)).toEqual([
    {
      type: "error",
      message: expect.stringMatching(
        /^connection error: websocket connection to ws:\/\/127\.0\.0\.1:\d+\/v1\/listen failed.*503$/,
      ),
      fatal: false,
    },
  ]);
  await stt.close();
});

test("meters what it is sent", async () => {
  const records: UsageRecord[] = [];
  setUsageSink((record) => records.push(record));
  const stt = await open();
  stt.send(new Int16Array(16000));
  await stt.close();
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    role: "hearing",
    provider: "deepgram",
    model: "nova-3-general",
    units: { audioSeconds: 1 },
  });
});
