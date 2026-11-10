import { afterEach, beforeEach, expect, test } from "bun:test";
import { CARTESIA_URL, CartesiaSpeech } from "../../src/speech/stream/cartesia.ts";
import {
  bytesOf,
  CLEAN_ENV,
  collect,
  type Fake,
  fakeServer,
  KEY,
  plain,
  selectionAt,
  setEnv,
  until,
} from "./fake.ts";

let fake: Fake;
let restore: () => void;
let streams: CartesiaSpeech[];

beforeEach(() => {
  restore = setEnv({ ...CLEAN_ENV, TTS_VOICE_ID: "v1" });
  streams = [];
});

afterEach(async () => {
  await Promise.all(streams.map((stream) => stream.close()));
  fake?.stop();
  restore();
});

function open(): CartesiaSpeech {
  const stream = new CartesiaSpeech(selectionAt("cartesia", fake.base));
  streams.push(stream);
  return stream;
}

const samples = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const chunk = (contextId: unknown, from: number, to: number) =>
  JSON.stringify({
    type: "chunk",
    context_id: contextId,
    data: Buffer.from(bytesOf(samples(from, to))).toString("base64"),
  });
const timestamps = (contextId: unknown, words: string[], start: number[]) =>
  JSON.stringify({ type: "timestamps", context_id: contextId, word_timestamps: { words, start } });

// What pipedog's CartesiaTTSService built from createTts for "你好。" in voice v1, context "ctx".
const TODAY =
  '{"transcript": "\\u4f60\\u597d\\u3002", "continue": true, "context_id": "ctx", "model_id": "sonic-3.6", ' +
  '"voice": {"mode": "id", "id": "v1"}, "output_format": {"container": "raw", "encoding": "pcm_s16le", ' +
  '"sample_rate": 24000}, "add_timestamps": true, "use_normalized_timestamps": false, ' +
  '"max_buffer_delay_ms": 0, "language": "zh"}';

test("pipedog's URL for Cartesia's own account", () => {
  expect(CARTESIA_URL).toBe("wss://api.cartesia.ai/tts/websocket");
});

test("today's message per segment and its flush; word timestamps split the audio", async () => {
  fake = fakeServer({
    onMessage: (peer, data) => {
      const message = JSON.parse(data as string);
      if (message.continue !== false) return;
      const id = message.context_id;
      peer.socket.send(timestamps(id, ["你", "好"], [0, 0.001]));
      peer.socket.send(chunk(id, 0, 48));
      peer.socket.send(timestamps(id, ['<break time="1s"/>再', "见"], [0.002, 0.003]));
      peer.socket.send(chunk(id, 48, 96));
      peer.socket.send(JSON.stringify({ type: "flush_done", context_id: id }));
      peer.socket.send(JSON.stringify({ type: "done", context_id: id }));
    },
  });
  const stream = open();
  const peer = await until(() => fake.peers[0]);
  expect(peer.path).toBe("/tts/websocket");
  expect(peer.headers.get("x-api-key")).toBe(KEY);
  expect(peer.headers.get("cartesia-version")).toBe("2026-03-01");

  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "你好。" });
  utterance.say({ id: 2, text: "再见。" });
  utterance.end();
  const events = await collect(utterance.audio);
  const id = JSON.parse(peer.received[0] as string).context_id;
  expect(peer.received[0]).toBe(TODAY.replace('"ctx"', `"${id}"`));
  expect(JSON.parse(peer.received[2] as string)).toMatchObject({
    transcript: "",
    continue: false,
    context_id: id,
  });
  expect(plain(events)).toEqual([
    { kind: "pcm", seg: 1, pcm: samples(0, 48) },
    {
      kind: "words",
      seg: 1,
      words: [
        { chars: 1, startMs: 0 },
        { chars: 2, startMs: 1 },
      ],
    },
    { kind: "seg-end", seg: 1 },
    { kind: "pcm", seg: 2, pcm: samples(48, 96) },
    {
      kind: "words",
      seg: 2,
      words: [
        { chars: 1, startMs: 0 },
        { chars: 2, startMs: 1 },
      ],
    },
    { kind: "seg-end", seg: 2 },
    { kind: "end" },
  ]);
});

test("cancel cancels the context; an error message fails the utterance", async () => {
  fake = fakeServer({
    onMessage: (peer, data) => {
      const message = JSON.parse(data as string);
      if (message.transcript === "坏。") {
        peer.socket.send(
          JSON.stringify({ type: "error", context_id: message.context_id, error: "bad voice" }),
        );
      }
    },
  });
  const stream = open();
  const cut = stream.utterance(null);
  cut.say({ id: 1, text: "好。" });
  cut.cancel();
  expect(await collect(cut.audio)).toEqual([]);
  const peer = await until(() => fake.peers[0]?.received.length === 2 && fake.peers[0]);
  const id = JSON.parse(peer.received[0] as string).context_id;
  expect(peer.received[1]).toBe(`{"context_id": "${id}", "cancel": true}`);

  const failing = stream.utterance("v2");
  failing.say({ id: 1, text: "坏。" });
  const [event] = await collect(failing.audio);
  expect(event?.kind).toBe("error");
  expect((event as { message: string }).message).toStartWith('Error: {"type":"error"');
  expect(JSON.parse(peer.received[2] as string).voice).toEqual({ mode: "id", id: "v2" });
});

test("a socket Cartesia dropped fails what was on it, and the next utterance reconnects", async () => {
  fake = fakeServer({ onMessage: (peer) => peer.socket.close(1000, "idle") });
  const stream = open();
  const first = stream.utterance(null);
  first.say({ id: 1, text: "一。" });
  expect(await collect(first.audio)).toEqual([
    { kind: "error", message: "Cartesia closed the connection (1000 idle)" },
  ]);
  stream.utterance(null).say({ id: 1, text: "二。" });
  await until(() => fake.peers[1]?.received.length === 1);
});

test("a refused key is an error that never carries it; no language for `none`", async () => {
  restore();
  restore = setEnv({ ...CLEAN_ENV, TTS_VOICE_ID: "v1", STT_LANGUAGE: "none" });
  fake = fakeServer({ refuse: 403 });
  const utterance = open().utterance(null);
  utterance.say({ id: 1, text: "嗨。" });
  const [event] = await collect(utterance.audio);
  expect((event as { message: string }).message).toStartWith("Unknown error occurred:");
  expect((event as { message: string }).message).not.toContain(KEY);
  expect(streams[0]?.language).toBeNull();
});
