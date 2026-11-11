import { afterEach, beforeEach, expect, test } from "bun:test";
import { ELEVENLABS_URL, ElevenLabsSpeech } from "../../src/speech/stream/elevenlabs.ts";
import {
  bytesOf,
  CLEAN_ENV,
  collect,
  type Fake,
  fakeServer,
  KEY,
  type Peer,
  plain,
  selectionAt,
  setEnv,
  until,
} from "./fake.ts";
import { captureIntervals, type Intervals } from "./intervals.ts";

let fake: Fake;
let restore: () => void;
let streams: ElevenLabsSpeech[];

beforeEach(() => {
  restore = setEnv({ ...CLEAN_ENV, TTS_VOICE_ID: "voice-1" });
  streams = [];
});

afterEach(async () => {
  await Promise.all(streams.map((stream) => stream.close()));
  fake?.stop();
  restore();
});

function open(): ElevenLabsSpeech {
  const stream = new ElevenLabsSpeech(selectionAt("elevenlabs", fake.base));
  streams.push(stream);
  return stream;
}

/** ElevenLabs' own answer to `close_socket`, around a test's handler. */
function serve(onMessage?: (peer: Peer, data: string | Uint8Array) => void): Fake {
  return fakeServer({
    onMessage: (peer, data) => {
      if (JSON.parse(data as string).close_socket === true) peer.socket.close(1000, "bye");
      else onMessage?.(peer, data);
    },
  });
}

const samples = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const audio = (from: number, to: number) =>
  Buffer.from(bytesOf(samples(from, to))).toString("base64");
const json = (peer: Peer) =>
  peer.received.map((data) => JSON.parse(data as string) as Record<string, unknown>);

/** Answers `close_context` with two chunks, aligned 24 samples (1 ms) a character, then isFinal. */
function answer(peer: Peer, data: string | Uint8Array): void {
  const message = JSON.parse(data as string) as Record<string, unknown>;
  const contextId = message.context_id;
  if (message.close_context !== true) return;
  peer.socket.send(
    JSON.stringify({
      contextId,
      audio: audio(0, 96),
      alignment: {
        chars: ["你", "好", "。", "再"],
        charStartTimesMs: [0, 1, 2, 3],
        charDurationsMs: [1, 1, 1, 1],
      },
      normalizedAlignment: null,
    }),
  );
  peer.socket.send(
    JSON.stringify({
      contextId,
      audio: audio(96, 144),
      alignment: { chars: ["见", "。"], charStartTimesMs: [0, 1], charDurationsMs: [1, 1] },
    }),
  );
  peer.socket.send(JSON.stringify({ contextId, isFinal: true }));
}

test("pipedog's URL for ElevenLabs' own account", () => {
  expect(ELEVENLABS_URL).toBe("wss://api.elevenlabs.io");
});

test("a context per utterance: today's messages out, audio split at each segment's last word", async () => {
  fake = serve(answer);
  const stream = open();
  expect(stream.sampleRate).toBe(24000);
  const peer = await until(() => fake.peers[0]);
  expect(peer.path).toBe(
    "/v1/text-to-speech/voice-1/multi-stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000&auto_mode=true",
  );
  expect(peer.headers.get("xi-api-key")).toBe(KEY);

  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "你好。" });
  utterance.say({ id: 2, text: "再见。" });
  utterance.end();
  const events = await collect(utterance.audio);

  const id = json(peer)[0]?.context_id as string;
  expect(peer.received).toEqual([
    `{"text": " ", "context_id": "${id}"}`,
    `{"text": "\\u4f60\\u597d\\u3002", "context_id": "${id}"}`,
    `{"text": "\\u518d\\u89c1\\u3002", "context_id": "${id}"}`,
    `{"context_id": "${id}", "flush": true}`,
    `{"context_id": "${id}", "close_context": true}`,
  ]);
  expect(plain(events)).toEqual([
    { kind: "pcm", seg: 1, pcm: samples(0, 72) },
    {
      kind: "words",
      seg: 1,
      words: [
        { chars: 1, startMs: 0 },
        { chars: 2, startMs: 1 },
      ],
    },
    { kind: "seg-end", seg: 1 },
    { kind: "pcm", seg: 2, pcm: samples(72, 96) },
    { kind: "words", seg: 2, words: [{ chars: 1, startMs: 0 }] },
    { kind: "words", seg: 2, words: [{ chars: 2, startMs: 1 }] },
    { kind: "pcm", seg: 2, pcm: samples(96, 144) },
    { kind: "seg-end", seg: 2 },
    { kind: "end" },
  ]);
});

test("cues are stripped for a model that can't read them; a cue-only segment still ends in order", async () => {
  fake = serve(answer);
  const stream = open();
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "[温柔] 你好。" });
  utterance.say({ id: 2, text: "<whisper></whisper>" });
  utterance.say({ id: 3, text: "再见。" });
  utterance.end();
  const events = await collect(utterance.audio);
  const peer = fake.peers[0] as Peer;
  expect(json(peer).map((message) => message.text)).toEqual([
    " ",
    "你好。",
    "再见。",
    undefined,
    undefined,
  ]);
  expect(events.filter((event) => event.kind === "seg-end")).toEqual([
    { kind: "seg-end", seg: 1 },
    { kind: "seg-end", seg: 2 },
    { kind: "seg-end", seg: 3 },
  ]);
});

test("cancel closes the context; an utterance with nothing said opens none", async () => {
  fake = serve();
  const stream = open();
  const peer = await until(() => fake.peers[0]);
  const empty = stream.utterance(null);
  empty.end();
  expect(await collect(empty.audio)).toEqual([{ kind: "end" }]);
  const cut = stream.utterance(null);
  cut.say({ id: 1, text: "好。" });
  cut.cancel();
  expect(await collect(cut.audio)).toEqual([]);
  await until(() => peer.received.length === 3);
  const id = json(peer)[0]?.context_id;
  expect(json(peer)).toEqual([
    { text: " ", context_id: id },
    { text: "好。", context_id: id },
    { context_id: id, close_context: true },
  ]);
});

test("another voice is another socket, since the voice is in the URL", async () => {
  fake = serve();
  const stream = open();
  await until(() => fake.peers[0]);
  stream.utterance("voice-2").say({ id: 1, text: "嗯。" });
  const second = await until(() => fake.peers[1]);
  expect(second.path).toStartWith("/v1/text-to-speech/voice-2/multi-stream-input?");
  await until(() => second.received.length === 2);
  stream.utterance(null).say({ id: 1, text: "好。" });
  await until(() => fake.peers[0]?.received.length === 2);
  expect(fake.peers).toHaveLength(2);
});

let intervals: Intervals;
test("a keepalive every 10 s names a context only once its first message is out", async () => {
  intervals = captureIntervals();
  try {
    fake = serve();
    const stream = open();
    const peer = await until(() => fake.peers[0]);
    const keepalive = await until(() => intervals.findLast((interval) => interval.ms === 10_000));
    keepalive.fire();
    const utterance = stream.utterance(null);
    keepalive.fire();
    utterance.say({ id: 1, text: "嗨。" });
    keepalive.fire();
    utterance.end();
    keepalive.fire();
    await until(() => peer.received.length === 8);
    const id = json(peer)[2]?.context_id;
    expect(json(peer).filter((message) => message.text === "")).toEqual([
      { text: "" },
      { text: "" },
      { text: "", context_id: id },
      { text: "" },
    ]);
  } finally {
    intervals.restore();
  }
});

test("closing asks ElevenLabs to close the socket, and a dropped socket fails its utterances", async () => {
  fake = fakeServer({
    onMessage: (peer, data) => {
      if (JSON.parse(data as string).close_socket === true) peer.socket.close(1000, "bye");
      if (JSON.parse(data as string).text === "坏。") peer.socket.close(1011, "boom");
    },
  });
  const stream = open();
  const doomed = stream.utterance(null);
  doomed.say({ id: 1, text: "坏。" });
  expect(await collect(doomed.audio)).toEqual([
    { kind: "error", message: "ElevenLabs closed the connection (1011 boom)" },
  ]);
  const again = stream.utterance(null);
  again.say({ id: 1, text: "好。" });
  const peer = await until(() => fake.peers[1]?.received.length === 2 && fake.peers[1]);
  await stream.close();
  expect(JSON.parse(peer.received.at(-1) as string)).toEqual({ close_socket: true });
  expect(peer.closed).toEqual({ code: 1000, reason: "bye" });
  expect(await collect(again.audio)).toEqual([]);
});

test("a refused key is an error that never carries it", async () => {
  fake = fakeServer({ refuse: 401 });
  const utterance = open().utterance(null);
  utterance.say({ id: 1, text: "嗨。" });
  const [event] = await collect(utterance.audio);
  expect(event).toMatchObject({ kind: "error" });
  expect((event as { message: string }).message).toContain("401");
  expect((event as { message: string }).message).not.toContain(KEY);
});
