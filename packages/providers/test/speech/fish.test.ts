import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { setUsageSink, type UsageRecord } from "../../src/index.ts";
import { FISH_SEGMENT_IDLE_MS, FISH_URL, FishSpeech } from "../../src/speech/stream/fish.ts";
import type { UtteranceAudio } from "../../src/speech/stream/index.ts";
import { packMsg, unpackMsg } from "../../src/speech/stream/msgpack.ts";
import { SPEECH_STALL_MS, SPEECH_STALLED } from "../../src/speech/stream/shared.ts";
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

const events = (peer: Peer) =>
  peer.received.map((data) => {
    const message = unpackMsg(data as Uint8Array) as { event: string; text?: string };
    return message.text ?? message.event;
  });

/**
 * A Fish that answers each flush in turn, 20 ms after it, with two messages 10 ms apart, every
 * sample the flush's number, and `stop` with `finish` once that audio is out. Returns when it got
 * each text, and when it sent each flush's last audio.
 */
function pacedFish(): { readonly texts: number[]; readonly lastAudio: number[] } {
  const texts: number[] = [];
  const lastAudio: number[] = [];
  let chain = Promise.resolve();
  let flushes = 0;
  fake = fakeServer({
    onMessage: (peer, data) => {
      const { event } = unpackMsg(data as Uint8Array) as { event: string };
      if (event === "text") texts.push(performance.now());
      if (event === "flush") {
        const n = ++flushes;
        chain = chain.then(async () => {
          await Bun.sleep(20);
          peer.socket.send(packMsg({ event: "audio", audio: bytesOf([n, n]) }));
          await Bun.sleep(10);
          peer.socket.send(packMsg({ event: "audio", audio: bytesOf([n]) }));
          lastAudio.push(performance.now());
        });
      } else if (event === "stop") {
        chain = chain.then(() => {
          peer.socket.send(packMsg({ event: "finish", reason: "stop" }));
        });
      }
    },
  });
  return { texts, lastAudio };
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
  // The stop went right after the last flush, and the finish ended that segment and the utterance.
  expect(plain(events)).toEqual([
    { kind: "pcm", seg: 1, pcm: [1] },
    { kind: "pcm", seg: 1, pcm: [-2, 300] },
    { kind: "seg-end", seg: 1 },
    { kind: "end" },
  ]);
  // The next utterance's session opened once this one stopped.
  const next = await until(() => heardFrom(fake, 1));
  expect(hex(next.received[0] as Uint8Array)).toBe(START_VOICE_1);
});

test("segments go one at a time, each once the last one's audio has gone quiet, its audio tagged with it", async () => {
  const { texts, lastAudio } = pacedFish();
  const utterance = open().utterance(null);
  utterance.say({ id: 1, text: "一。" });
  utterance.say({ id: 2, text: "二。" });
  utterance.say({ id: 3, text: "三。" });
  utterance.end();
  const audio = await collect(utterance.audio);
  expect(events(fake.peers[0] as Peer)).toEqual([
    "start",
    "一。",
    "flush",
    "二。",
    "flush",
    "三。",
    "flush",
    "stop",
  ]);
  for (let n = 1; n < texts.length; n++) {
    const quiet = (texts[n] as number) - (lastAudio[n - 1] as number);
    expect(quiet).toBeGreaterThanOrEqual(FISH_SEGMENT_IDLE_MS - 2);
  }
  expect(plain(audio)).toEqual([
    ...[1, 2, 3].flatMap((seg) => [
      { kind: "pcm", seg, pcm: [seg, seg] },
      { kind: "pcm", seg, pcm: [seg] },
      { kind: "seg-end", seg },
    ]),
    { kind: "end" },
  ]);
});

test("a segment left with nothing to say ends in its place and goes to no one", async () => {
  pacedFish();
  const utterance = open().utterance(null);
  utterance.say({ id: 1, text: "一。" });
  utterance.say({ id: 2, text: "  " });
  utterance.say({ id: 3, text: "三。" });
  utterance.end();
  const audio = await collect(utterance.audio);
  expect(events(fake.peers[0] as Peer)).toEqual([
    "start",
    "一。",
    "flush",
    "三。",
    "flush",
    "stop",
  ]);
  expect(audio.filter((item) => item.kind !== "pcm")).toEqual([
    { kind: "seg-end", seg: 1 },
    { kind: "seg-end", seg: 2 },
    { kind: "seg-end", seg: 3 },
    { kind: "end" },
  ]);
});

test("a cancel drops the segments waiting and sends nothing more on the session", async () => {
  pacedFish();
  const utterance = open().utterance(null);
  const audio = utterance.audio[Symbol.asyncIterator]();
  utterance.say({ id: 1, text: "一。" });
  utterance.say({ id: 2, text: "二。" });
  utterance.end();
  expect(plain([(await audio.next()).value])).toEqual([{ kind: "pcm", seg: 1, pcm: [1, 1] }]);
  utterance.cancel();
  const peer = await until(() => fake.peers[0]?.closed && fake.peers[0]);
  await Bun.sleep(FISH_SEGMENT_IDLE_MS + 50);
  expect(events(peer)).toEqual(["start", "一。", "flush"]);
  expect((await audio.next()).done).toBe(true);
});

test("a flush that never answers fails the utterance 15 s on, so no segment waits behind it for ever", async () => {
  const silent = Promise.withResolvers<Peer>();
  fake = fakeServer({
    onMessage: (peer, data) => {
      if ((unpackMsg(data as Uint8Array) as { event: string }).event !== "flush") return;
      if (peer.received.length === 3) {
        peer.socket.send(packMsg({ event: "audio", audio: bytesOf([1]) }));
      } else {
        silent.resolve(peer);
      }
    },
  });
  const stream = open();
  // No `until` from here: the fake clock holds Bun.sleep too.
  jest.useFakeTimers();
  try {
    const seen: UtteranceAudio[] = [];
    const first = Promise.withResolvers<void>();
    const utterance = stream.utterance(null);
    const reading = (async () => {
      for await (const item of utterance.audio) {
        seen.push(item);
        first.resolve();
      }
    })();
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    utterance.say({ id: 1, text: "一。" });
    utterance.say({ id: 2, text: "二。" });
    utterance.end();
    await first.promise;
    jest.advanceTimersByTime(FISH_SEGMENT_IDLE_MS);
    const peer = await silent.promise;
    jest.advanceTimersByTime(SPEECH_STALL_MS - 1);
    await settle();
    expect(plain(seen)).toEqual([
      { kind: "pcm", seg: 1, pcm: [1] },
      { kind: "seg-end", seg: 1 },
    ]);
    jest.advanceTimersByTime(1);
    await reading;
    expect(seen.at(-1)).toEqual({ kind: "error", message: SPEECH_STALLED });
    expect(events(peer).slice(0, 5)).toEqual(["start", "一。", "flush", "二。", "flush"]);
  } finally {
    jest.useRealTimers();
  }
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

test("a voice switch while segments wait leaves the new voice's session to the next utterance", async () => {
  pacedFish();
  const stream = open();
  const before = stream.utterance(null);
  before.say({ id: 1, text: "一。" });
  before.say({ id: 2, text: "二。" });
  before.end();
  const styled = stream.utterance("voice-2");
  styled.say({ id: 3, text: "三。" });
  styled.end();
  await Promise.all([collect(before.audio), collect(styled.audio)]);
  const opened = fake.peers.length;
  const next = stream.utterance("voice-2");
  next.say({ id: 1, text: "好。" });
  const peer = await until(() => fake.peers.find((p) => events(p).includes("好。")));
  expect(fake.peers.indexOf(peer)).toBeLessThan(opened);
  expect(unpackMsg(peer.received[0] as Uint8Array)).toMatchObject({
    request: { reference_id: "voice-2" },
  });
});

test("an utterance with nothing said hands its session to the next", async () => {
  fake = fakeServer();
  const stream = open();
  const empty = stream.utterance(null);
  empty.say({ id: 1, text: "  " });
  empty.end();
  expect(await collect(empty.audio)).toEqual([{ kind: "seg-end", seg: 1 }, { kind: "end" }]);
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
