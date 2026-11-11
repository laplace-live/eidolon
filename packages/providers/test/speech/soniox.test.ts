import { afterEach, beforeEach, expect, test } from "bun:test";
import { SONIOX_URL, SonioxSpeech } from "../../src/speech/stream/soniox.ts";
import { sonioxUrl } from "../../src/stt/soniox.ts";
import { selectionAt as hearingAt } from "../stt/fake.ts";
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
import { captureIntervals } from "./intervals.ts";

let fake: Fake;
let restore: () => void;
let streams: SonioxSpeech[];

beforeEach(() => {
  restore = setEnv(CLEAN_ENV);
  streams = [];
});

afterEach(async () => {
  await Promise.all(streams.map((stream) => stream.close()));
  fake?.stop();
  restore();
});

function open(): SonioxSpeech {
  const stream = new SonioxSpeech(selectionAt("soniox", fake.base));
  streams.push(stream);
  return stream;
}

const samples = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const audio = (from: number, to: number) =>
  Buffer.from(bytesOf(samples(from, to))).toString("base64");

test("pipedog's URL for Soniox's own account", () => {
  expect(SONIOX_URL).toBe("wss://tts-rt.soniox.com/tts-websocket");
});

test("an account's API base moves her voice's socket to its origin, as it moves her hearing's", async () => {
  fake = fakeServer();
  const base = `${fake.base}/soniox`;
  streams.push(new SonioxSpeech(selectionAt("soniox", base)));
  const peer = await until(() => fake.peers[0]);
  expect(peer.path).toBe("/tts-websocket");
  expect(sonioxUrl(hearingAt("soniox", base))).toBe(
    `${fake.base.replace(/^http/, "ws")}/transcribe-websocket`,
  );
});

test("a stream per utterance, configured as today before its text; timestamps split the audio", async () => {
  fake = fakeServer({
    onMessage: (peer, data) => {
      const message = JSON.parse(data as string);
      if (message.text_end !== true) return;
      const stream_id = message.stream_id;
      peer.socket.send(
        JSON.stringify({
          stream_id,
          audio: audio(0, 96),
          timestamps: {
            characters: ["H", "i", " ", "y", "o", "u", "."],
            character_start_times_seconds: [0, 0.0005, 0.001, 0.002, 0.0025, 0.003, 0.0035],
          },
        }),
      );
      peer.socket.send(JSON.stringify({ stream_id, audio_end: true }));
      peer.socket.send(JSON.stringify({ stream_id, terminated: true }));
    },
  });
  const stream = open();
  const peer = await until(() => fake.peers[0]);
  expect(peer.path).toBe("/tts-websocket");
  expect(peer.headers.get("authorization")).toBe(`Bearer ${KEY}`);

  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "Hi" });
  utterance.say({ id: 2, text: "you." });
  utterance.end();
  const events = await collect(utterance.audio);
  const id = JSON.parse(peer.received[0] as string).stream_id;
  expect(peer.received).toEqual([
    `{"stream_id": "${id}", "model": "tts-rt-v2", "voice": "Bryce", "audio_format": "pcm_s16le", "language": "zh", "return_timestamps": true, "sample_rate": 24000}`,
    `{"text": "Hi", "text_end": false, "stream_id": "${id}"}`,
    `{"text": "you.", "text_end": false, "stream_id": "${id}"}`,
    `{"text": "", "text_end": true, "stream_id": "${id}"}`,
  ]);
  // "Hi" ends where "you" starts, 48 samples in.
  expect(plain(events)).toEqual([
    { kind: "pcm", seg: 1, pcm: samples(0, 48) },
    { kind: "words", seg: 1, words: [{ chars: 2, startMs: 0 }] },
    { kind: "seg-end", seg: 1 },
    { kind: "pcm", seg: 2, pcm: samples(48, 96) },
    { kind: "words", seg: 2, words: [{ chars: 3, startMs: 0 }] },
    { kind: "seg-end", seg: 2 },
    { kind: "end" },
  ]);
});

test("a voice of her own, a regional language as its base, and no stream left open when nothing was said", async () => {
  restore();
  restore = setEnv({ ...CLEAN_ENV, TTS_VOICE_ID: "Maya", STT_LANGUAGE: "zh-CN" });
  fake = fakeServer();
  const stream = open();
  const empty = stream.utterance(null);
  empty.end();
  expect(await collect(empty.audio)).toEqual([{ kind: "end" }]);
  const styled = stream.utterance("Adrian");
  styled.say({ id: 1, text: "好。" });
  styled.cancel();
  const peer = await until(() => fake.peers[0]?.received.length === 5 && fake.peers[0]);
  const sent = peer.received.map((data) => JSON.parse(data as string));
  expect(sent[0]).toMatchObject({ voice: "Maya", language: "zh" });
  expect(sent[1]).toEqual({ stream_id: sent[0].stream_id, cancel: true });
  expect(sent[2]).toMatchObject({ voice: "Adrian" });
  expect(sent[4]).toEqual({ stream_id: sent[2].stream_id, cancel: true });
});

test("an error code fails the utterance with today's text", async () => {
  fake = fakeServer({
    onMessage: (peer, data) => {
      const message = JSON.parse(data as string);
      if (message.text === undefined) return;
      peer.socket.send(
        JSON.stringify({
          stream_id: message.stream_id,
          error_code: 402,
          error_type: "organization_balance_exhausted",
          error_message: "Out of credit",
        }),
      );
    },
  });
  const utterance = open().utterance(null);
  utterance.say({ id: 1, text: "嗨。" });
  const [event] = await collect(utterance.audio);
  expect((event as { message: string }).message).toMatch(
    /^Soniox TTS error 402 organization_balance_exhausted \(stream [0-9a-f-]{36}\): Out of credit$/,
  );
});

test("a keepalive every 20 s", async () => {
  const intervals = captureIntervals();
  try {
    fake = fakeServer();
    open();
    const peer = await until(() => fake.peers[0]);
    const keepalive = await until(() => intervals.findLast((interval) => interval.ms === 20_000));
    keepalive.fire();
    await until(() => peer.received.length === 1);
    expect(peer.received).toEqual(['{"keep_alive": true}']);
  } finally {
    intervals.restore();
  }
});

test("a refused key is an error that never carries it", async () => {
  fake = fakeServer({ refuse: 401 });
  const utterance = open().utterance(null);
  utterance.say({ id: 1, text: "嗨。" });
  const [event] = await collect(utterance.audio);
  expect((event as { message: string }).message).toStartWith("Unable to connect to Soniox TTS:");
  expect((event as { message: string }).message).not.toContain(KEY);
});
