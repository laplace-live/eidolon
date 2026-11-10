import { afterEach, beforeEach, expect, test } from "bun:test";
import { setUsageSink, type UsageRecord } from "../../src/index.ts";
import { FISH_URL, FishSpeech } from "../../src/speech/stream/fish.ts";
import { packMsg, unpackMsg } from "../../src/speech/stream/msgpack.ts";
import {
  bytesOf,
  CLEAN_ENV,
  collect,
  type Fake,
  fakeServer,
  heardFrom,
  KEY,
  type Peer,
  plain,
  selectionAt,
  setEnv,
  until,
} from "./fake.ts";

const hex = (bytes: string | Uint8Array) => Buffer.from(bytes as Uint8Array).toString("hex");

// What pipedog's FishAudioTTSService sent from createTts, captured against a fake: the start
// message for voice "voice-1", then "你好呀。" as text and flush.
const START_VOICE_1 =
  "82a56576656e74a57374617274a77265717565737487a474657874a0ab73616d706c655f72617465cdac44a76c6174" +
  "656e6379a66e6f726d616ca6666f726d6174a370636da96e6f726d616c697a65c2a770726f736f647982a573706565" +
  "6401a6766f6c756d6500ac7265666572656e63655f6964a7766f6963652d31";
const TEXT_NI_HAO_YA = "82a56576656e74a474657874a474657874ace4bda0e5a5bde59180e38082";
const FLUSH = "81a56576656e74a5666c757368";
const STOP = "81a56576656e74a473746f70";

let fake: Fake;
let restore: () => void;
let records: UsageRecord[];
let streams: FishSpeech[];

/** Answers `stop` with audio split mid-sample, then `finish`. */
function answer(peer: Peer, data: string | Uint8Array): void {
  if (typeof data === "string") return;
  const message = unpackMsg(data) as { event: string };
  if (message.event !== "stop") return;
  const audio = bytesOf([1, -2, 300]);
  peer.socket.send(packMsg({ event: "audio", audio: audio.subarray(0, 3) }));
  peer.socket.send(packMsg({ event: "audio", audio: audio.subarray(3) }));
  peer.socket.send(packMsg({ event: "finish", reason: "stop" }));
}

beforeEach(() => {
  restore = setEnv({ ...CLEAN_ENV, TTS_VOICE_ID: "voice-1" });
  records = [];
  streams = [];
  setUsageSink((record) => records.push(record));
});

afterEach(async () => {
  await Promise.all(streams.map((stream) => stream.close()));
  fake?.stop();
  setUsageSink(null);
  restore();
});

function open(variables: Record<string, string> = {}): FishSpeech {
  const stream = new FishSpeech(selectionAt("fish", fake.base, variables));
  streams.push(stream);
  return stream;
}

test("pipedog's URL for Fish's own account", () => {
  expect(FISH_URL).toBe("wss://api.fish.audio/v1/tts/live");
});

test("a session opens at once with today's start message, and an utterance says, flushes and stops", async () => {
  fake = fakeServer({ onMessage: answer });
  const stream = open();
  expect(stream.sampleRate).toBe(44100);
  const first = await until(() => heardFrom(fake, 0));
  expect(first.path).toBe("/v1/tts/live");
  expect(first.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(first.headers.get("model")).toBe("drama-3");
  expect(hex(first.received[0] as Uint8Array)).toBe(START_VOICE_1);

  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "你好呀。" });
  utterance.end();
  const events = await collect(utterance.audio);
  expect(first.received.slice(1).map((data) => hex(data as Uint8Array))).toEqual([
    TEXT_NI_HAO_YA,
    FLUSH,
    STOP,
  ]);
  expect(plain(events)).toEqual([
    { kind: "pcm", seg: null, pcm: [1] },
    { kind: "pcm", seg: null, pcm: [-2, 300] },
    { kind: "end" },
  ]);
  // The next utterance's session opened once this one stopped.
  const next = await until(() => heardFrom(fake, 1));
  expect(hex(next.received[0] as Uint8Array)).toBe(START_VOICE_1);
});

test("drama-3 hears her cues; another Fish model gets them stripped, and the meter counts what went", async () => {
  fake = fakeServer();
  const drama = open();
  const cue = "[温柔] 好<emphasis>呀</emphasis>";
  const said = drama.utterance(null);
  said.say({ id: 1, text: cue });
  const s21 = open({ TTS_MODEL: "s2.1-pro" });
  const stripped = s21.utterance(null);
  stripped.say({ id: 1, text: cue });
  const texts = await until(() => {
    const sent = fake.peers.flatMap((peer) =>
      peer.received.map(
        (data) => unpackMsg(data as Uint8Array) as { event: string; text?: string },
      ),
    );
    const text = sent.filter((message) => message.event === "text").map((m) => m.text);
    return text.length === 2 && text;
  });
  expect(texts.sort()).toEqual(["[温柔] 好呀", cue].sort());
  await drama.close();
  await s21.close();
  expect(
    records.map(({ role, provider, model, units }) => ({ role, provider, model, units })),
  ).toEqual([
    {
      role: "voice",
      provider: "fish",
      model: "drama-3",
      units: { characters: [...cue].length, bytes: Buffer.byteLength(cue) },
    },
    {
      role: "voice",
      provider: "fish",
      model: "s2.1-pro",
      units: { characters: [..."[温柔] 好呀"].length, bytes: Buffer.byteLength("[温柔] 好呀") },
    },
  ]);
});

test("another voice opens its own session, and the next one opens in the voice last used", async () => {
  fake = fakeServer();
  const stream = open();
  await until(() => fake.peers[0]?.received[0]);
  const styled = stream.utterance("voice-2");
  styled.say({ id: 1, text: "嗯。" });
  const second = await until(() => heardFrom(fake, 1));
  expect(unpackMsg(second.received[0] as Uint8Array)).toMatchObject({
    event: "start",
    request: { reference_id: "voice-2" },
  });
  styled.cancel();
  const third = await until(() => heardFrom(fake, 2));
  expect(unpackMsg(third.received[0] as Uint8Array)).toMatchObject({
    request: { reference_id: "voice-2" },
  });
  await until(() => fake.peers[0]?.closed);
  const again = stream.utterance("voice-2");
  again.say({ id: 2, text: "好。" });
  await until(() => third.received.length === 3);
  expect(unpackMsg(third.received[1] as Uint8Array)).toEqual({ event: "text", text: "好。" });
});

test("an utterance with nothing said hands its session to the next", async () => {
  fake = fakeServer();
  const stream = open();
  const empty = stream.utterance(null);
  empty.say({ id: 1, text: "  " });
  empty.end();
  expect(await collect(empty.audio)).toEqual([{ kind: "end" }]);
  const next = stream.utterance(null);
  next.say({ id: 2, text: "在。" });
  await until(() => fake.peers[0]?.received.length === 3);
  await Bun.sleep(50);
  expect(fake.peers).toHaveLength(1);
});

test("cancel closes the session at once and opens the next", async () => {
  fake = fakeServer();
  const stream = open();
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "一二三。" });
  const peer = await until(() => fake.peers[0]?.received.length === 3 && fake.peers[0]);
  utterance.cancel();
  expect(await collect(utterance.audio)).toEqual([]);
  await until(() => peer.closed);
  expect(
    peer.received.map((data) => (unpackMsg(data as Uint8Array) as { event: string }).event),
  ).toEqual(["start", "text", "flush"]);
  await until(() => fake.peers[1]?.received[0]);
});

test("barge-ins while sessions are still connecting abandon their handshakes", async () => {
  // A server that takes connections and never answers the upgrade.
  let connected = 0;
  let open = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: () => {
        connected++;
        open++;
      },
      close: () => {
        open--;
      },
      data: () => {},
    },
  });
  try {
    const stream = new FishSpeech(selectionAt("fish", `http://127.0.0.1:${listener.port}`));
    streams.push(stream);
    await until(() => connected === 1);
    for (const next of [2, 3, 4]) {
      const utterance = stream.utterance(null);
      utterance.say({ id: 1, text: "一。" });
      utterance.cancel();
      await until(() => connected === next);
    }
    await until(() => open === 1);
  } finally {
    listener.stop(true);
  }
});

test("Fish's error finish and a refused key are errors that never carry the key", async () => {
  fake = fakeServer({
    onMessage: (peer, data) => {
      const message = unpackMsg(data as Uint8Array) as { event: string };
      if (message.event === "flush")
        peer.socket.send(packMsg({ event: "finish", reason: "error" }));
    },
  });
  const failing = open().utterance(null);
  failing.say({ id: 1, text: "坏。" });
  expect(await collect(failing.audio)).toEqual([
    { kind: "error", message: "Fish Audio server error during synthesis" },
  ]);
  fake.stop();

  fake = fakeServer({ refuse: 401 });
  const refused = open().utterance(null);
  refused.say({ id: 1, text: "嗨。" });
  const [event] = await collect(refused.audio);
  expect(event?.kind).toBe("error");
  const message = (event as { message: string }).message;
  expect(message).toStartWith("Unknown error occurred: websocket connection to");
  expect(message).toContain("401");
  expect(message).not.toContain(KEY);
});

test("closing the stream ends an open utterance and flushes the meter", async () => {
  fake = fakeServer();
  const stream = open();
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "再见。" });
  await until(() => fake.peers[0]?.received.length === 3);
  await stream.close();
  expect(await collect(utterance.audio)).toEqual([]);
  expect(records).toHaveLength(1);
});
