import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { setUsageSink, type UsageRecord } from "../../src/index.ts";
import { FishSpeechSelfHosted } from "../../src/speech/stream/fish-speech.ts";
import { SpeechError } from "../../src/speech/stream/http.ts";
import { openSpeech, type SpeechStream } from "../../src/speech/stream/index.ts";
import { MiniMaxSpeech } from "../../src/speech/stream/minimax.ts";
import { OpenAISpeech } from "../../src/speech/stream/openai.ts";
import { encodeWav, pcmBody, stripWavHeader } from "../../src/speech/wav.ts";
import { useFakeClock } from "../clock.ts";
import {
  bytesOf,
  CLEAN_ENV,
  collect,
  type Fake,
  fakeServer,
  type HttpRequest,
  KEY,
  plain,
  selectionAt,
  setEnv,
  until,
} from "./fake.ts";

let fake: Fake;
let restore: () => void;
let records: UsageRecord[];
let streams: SpeechStream[];

beforeEach(() => {
  restore = setEnv(CLEAN_ENV);
  records = [];
  streams = [];
  setUsageSink((record) => records.push(record));
});

afterEach(async () => {
  await Promise.all(streams.map((stream) => stream.close()));
  await fake?.stop();
  setUsageSink(null);
  restore();
});

function keep<T extends SpeechStream>(stream: T): T {
  streams.push(stream);
  return stream;
}

const hex = (samples: number[]) => Buffer.from(bytesOf(samples)).toString("hex");

/** A body that sends `pieces` with a pause before each. */
function streamed(pieces: (string | Uint8Array)[], pauseMs = 5): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const piece of pieces) {
          await delay(pauseMs);
          controller.enqueue(typeof piece === "string" ? encoder.encode(piece) : piece);
        }
        controller.close();
      },
    }),
  );
}

/** MiniMax's stream for `samples`: two audio blocks, then the whole again under extra_info, cut up anywhere. */
function minimaxBody(samples: number[]): string {
  const blocks = [
    `data: {"data":{"audio":"${hex(samples.slice(0, 2))}","status":1},"trace_id":"t"}\n\n`,
    `data: {"data":{"audio":"${hex(samples.slice(2))}","status":1},"trace_id":"t"}\n\n`,
    `data: {"data":{"audio":"${hex(samples)}","status":2},"extra_info":{"audio_length":1},"trace_id":"t"}\n\n`,
  ];
  return blocks.join("");
}

function pieces(text: string, cuts: number[]): string[] {
  const out: string[] = [];
  let from = 0;
  for (const cut of [...cuts, text.length]) {
    out.push(text.slice(from, cut));
    from = cut;
  }
  return out;
}

test("MiniMax: today's request per segment, blocks read across pieces, the summary block skipped", async () => {
  fake = await fakeServer({ http: () => streamed(pieces(minimaxBody([1, 2, 3]), [7, 33, 61])) });
  const stream = keep(
    new MiniMaxSpeech(selectionAt("minimax", `${fake.base}/v1/`, {}, { groupId: "g1" })),
  );
  expect(stream.sampleRate).toBe(24000);
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "你好。" });
  utterance.end();
  expect(plain(await collect(utterance.audio))).toEqual([
    { kind: "pcm", seg: 1, pcm: [1, 2] },
    { kind: "pcm", seg: 1, pcm: [3] },
    { kind: "seg-end", seg: 1 },
    { kind: "end" },
  ]);
  const [request] = fake.requests as [HttpRequest];
  expect(request.path).toBe("/v1/t2a_v2?GroupId=g1");
  expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(request.headers.get("accept")).toBe("application/json, text/plain, */*");
  expect(request.headers.get("content-type")).toBe("application/json");
  expect(request.body).toBe(
    '{"stream": true, "voice_setting": {"voice_id": "Calm_Woman", "speed": 1, "vol": 1, "pitch": 0}, ' +
      '"audio_setting": {"bitrate": 128000, "format": "pcm", "channel": 1, "sample_rate": 24000}, ' +
      '"model": "speech-2.8-turbo", "text": "\\u4f60\\u597d\\u3002"}',
  );
});

test("two requests at a time, each segment's audio played in the order said", async () => {
  const held: ((response: Response) => void)[] = [];
  fake = await fakeServer({
    http: () => new Promise<Response>((resolve) => held.push(resolve)),
  });
  const stream = keep(new OpenAISpeech(selectionAt("openai", `${fake.base}/v1`)));
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "一。" });
  utterance.say({ id: 2, text: "  " });
  utterance.say({ id: 3, text: "二。" });
  utterance.say({ id: 4, text: "三。" });
  utterance.end();
  await until(() => held.length === 2);
  await delay(30);
  expect(fake.requests.map((request) => JSON.parse(request.body).input)).toEqual(["一。", "二。"]);
  held[1]?.(new Response(bytesOf([30, 31])));
  await until(() => held.length === 3);
  held[2]?.(new Response(bytesOf([40])));
  // A piece goes once the last one's audio is out: fetch hands over pieces that waited as one.
  const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  held[0]?.(new Response(new ReadableStream({ start: (controller) => body.resolve(controller) })));
  const audio = utterance.audio[Symbol.asyncIterator]();
  const sending = await body.promise;
  sending.enqueue(bytesOf([10]));
  expect(plain([(await audio.next()).value])).toEqual([{ kind: "pcm", seg: 1, pcm: [10] }]);
  sending.enqueue(bytesOf([11]));
  sending.close();
  expect(plain(await collect(utterance.audio))).toEqual([
    { kind: "pcm", seg: 1, pcm: [11] },
    { kind: "seg-end", seg: 1 },
    { kind: "seg-end", seg: 2 },
    { kind: "pcm", seg: 3, pcm: [30, 31] },
    { kind: "seg-end", seg: 3 },
    { kind: "pcm", seg: 4, pcm: [40] },
    { kind: "seg-end", seg: 4 },
    { kind: "end" },
  ]);
});

test("OpenAI: today's request, a sample split between pieces kept whole", async () => {
  restore();
  restore = setEnv({ ...CLEAN_ENV, TTS_VOICE_ID: "coral" });
  const pcm = bytesOf([1000, -1000, 7]);
  const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  fake = await fakeServer({
    http: () =>
      new Response(new ReadableStream({ start: (controller) => body.resolve(controller) })),
  });
  const stream = keep(new OpenAISpeech(selectionAt("openai", `${fake.base}/v1`)));
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "你好。" });
  utterance.end();
  // A piece goes once the last one's samples are out: fetch hands over pieces that waited as one.
  const audio = utterance.audio[Symbol.asyncIterator]();
  const next = async () => plain([(await audio.next()).value])[0];
  const sending = await body.promise;
  sending.enqueue(pcm.subarray(0, 3));
  expect(await next()).toEqual({ kind: "pcm", seg: 1, pcm: [1000] });
  sending.enqueue(pcm.subarray(3, 5));
  expect(await next()).toEqual({ kind: "pcm", seg: 1, pcm: [-1000] });
  sending.enqueue(pcm.subarray(5));
  sending.close();
  expect(plain(await collect(utterance.audio))).toEqual([
    { kind: "pcm", seg: 1, pcm: [7] },
    { kind: "seg-end", seg: 1 },
    { kind: "end" },
  ]);
  const [request] = fake.requests as [HttpRequest];
  expect(request.path).toBe("/v1/audio/speech");
  expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(request.body).toBe(
    '{"input":"你好。","model":"gpt-4o-mini-tts","voice":"coral","response_format":"pcm"}',
  );
});

test("a failed request is an error without the key, and stops the rest", async () => {
  fake = await fakeServer({
    http: (request) =>
      JSON.parse(request.body).input === "坏。"
        ? new Response(`{"error":{"message":"Incorrect API key provided: ${KEY}"}}`, {
            status: 401,
          })
        : new Response(bytesOf([1])),
  });
  const utterance = keep(new OpenAISpeech(selectionAt("openai", `${fake.base}/v1`))).utterance(
    null,
  );
  utterance.say({ id: 1, text: "坏。" });
  const events = await collect(utterance.audio);
  expect(events).toEqual([
    {
      kind: "error",
      message:
        'Error getting audio (status: 401, error: {"error":{"message":"Incorrect API key provided: [key]"}})',
    },
  ]);
  utterance.say({ id: 2, text: "好。" });
  await delay(20);
  expect(fake.requests).toHaveLength(1);

  await fake.stop();
  fake = await fakeServer({ http: () => new Response("", { status: 500 }) });
  const minimax = keep(new MiniMaxSpeech(selectionAt("minimax", fake.base, {}, { groupId: "g" })));
  const failing = minimax.utterance(null);
  failing.say({ id: 1, text: "嗨。" });
  expect(await collect(failing.audio)).toEqual([
    { kind: "error", message: "MiniMax TTS error: HTTP 500" },
  ]);
});

test("MiniMax: a refusal answered 200, whole or mid-stream, is an error", async () => {
  fake = await fakeServer({
    http: (request) =>
      JSON.parse(request.body).text === "一。"
        ? new Response('{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}')
        : streamed([
            `data: {"data":{"audio":"${hex([1])}","status":1},"base_resp":{"status_code":0,"status_msg":""}}\n\n`,
            'data: {"data":{"audio":"","status":1},"base_resp":{"status_code":1026,"status_msg":"sensitive"}}\n\n',
          ]),
  });
  const stream = keep(new MiniMaxSpeech(selectionAt("minimax", fake.base, {}, { groupId: "g" })));
  const refused = stream.utterance(null);
  refused.say({ id: 1, text: "一。" });
  refused.end();
  expect(await collect(refused.audio)).toEqual([
    { kind: "error", message: "MiniMax TTS error: insufficient balance (1008)" },
  ]);
  const cut = stream.utterance(null);
  cut.say({ id: 1, text: "二。" });
  cut.end();
  expect(plain(await collect(cut.audio))).toEqual([
    { kind: "pcm", seg: 1, pcm: [1] },
    { kind: "error", message: "MiniMax TTS error: sensitive (1026)" },
  ]);
});

test("a request that sends no audio for 15 s has stalled; each piece puts that off", async () => {
  // No `until` here: its deadline is on the fake clock.
  useFakeClock();
  try {
    const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const unanswered = Promise.withResolvers<void>();
    fake = await fakeServer({
      http: (request) => {
        if (JSON.parse(request.body).input === "二。") {
          unanswered.resolve();
          return new Promise<Response>(() => {});
        }
        return new Response(
          new ReadableStream({ start: (controller) => body.resolve(controller) }),
        );
      },
    });
    const stream = keep(new OpenAISpeech(selectionAt("openai", fake.base)));
    const silent = stream.utterance(null);
    silent.say({ id: 1, text: "二。" });
    await unanswered.promise;
    vi.advanceTimersByTime(15_000);
    expect(await collect(silent.audio)).toEqual([
      { kind: "error", message: "No speech audio arrived within 15 seconds" },
    ]);

    const utterance = stream.utterance(null);
    utterance.say({ id: 1, text: "一。" });
    utterance.end();
    const events = utterance.audio[Symbol.asyncIterator]();
    const next = async () => plain([(await events.next()).value])[0];
    const sending = await body.promise;
    sending.enqueue(bytesOf([1]));
    expect(await next()).toEqual({ kind: "pcm", seg: 1, pcm: [1] });
    vi.advanceTimersByTime(10_000);
    sending.enqueue(bytesOf([2]));
    expect(await next()).toEqual({ kind: "pcm", seg: 1, pcm: [2] });
    vi.advanceTimersByTime(10_000);
    sending.enqueue(bytesOf([3]));
    expect(await next()).toEqual({ kind: "pcm", seg: 1, pcm: [3] });
    vi.advanceTimersByTime(15_000);
    expect(await next()).toEqual({
      kind: "error",
      message: "No speech audio arrived within 15 seconds",
    });
  } finally {
    vi.useRealTimers();
  }
});

test("an unknown OpenAI voice fails before any request", async () => {
  fake = await fakeServer({ http: () => new Response(bytesOf([1])) });
  const utterance = keep(new OpenAISpeech(selectionAt("openai", fake.base))).utterance("bogus");
  utterance.say({ id: 1, text: "嗨。" });
  const [event] = await collect(utterance.audio);
  expect(event).toEqual({
    kind: "error",
    message:
      "OpenAI TTS voice 'bogus' is not supported (must be one of: alloy, ash, ballad, cedar, coral, " +
      "echo, fable, marin, nova, onyx, sage, shimmer, verse)",
  });
  expect(fake.requests).toHaveLength(0);
});

test("cancel aborts what is in flight; closing the stream ends what is open and meters what went", async () => {
  fake = await fakeServer({ http: () => new Promise<Response>(() => {}) });
  const stream = keep(new OpenAISpeech(selectionAt("openai", fake.base)));
  const cut = stream.utterance(null);
  cut.say({ id: 1, text: "一。" });
  await until(() => fake.requests.length === 1);
  cut.cancel();
  expect(await collect(cut.audio)).toEqual([]);
  const open = stream.utterance("ash");
  open.say({ id: 2, text: "二三。" });
  await until(() => fake.requests.length === 2);
  await stream.close();
  expect(await collect(open.audio)).toEqual([]);
  expect(records).toMatchObject([
    {
      role: "voice",
      provider: "openai",
      model: "gpt-4o-mini-tts",
      units: { characters: 5, bytes: 15 },
    },
  ]);
});

test("openSpeech speaks for the voice role in scope, and refuses before connecting", async () => {
  fake = await fakeServer({ http: () => new Response(bytesOf([5])) });
  restore();
  restore = setEnv({ ...CLEAN_ENV, TTS_PROVIDER: "openai" });
  expect(() => openSpeech()).toThrow("OpenAI needs an API key: set OPENAI_API_KEY");
  setEnv({ OPENAI_API_KEY: KEY, OPENAI_BASE_URL: `${fake.base}/v1`, TTS_VOICE_ID: "sage" });
  const stream = keep(openSpeech());
  expect(stream).toBeInstanceOf(OpenAISpeech);
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "嗨。" });
  utterance.end();
  expect(plain(await collect(utterance.audio))).toContainEqual({ kind: "pcm", seg: 1, pcm: [5] });
  expect(JSON.parse(fake.requests[0]?.body ?? "{}").voice).toBe("sage");

  setEnv({ TTS_PROVIDER: "minimax", MINIMAX_API_KEY: KEY });
  expect(() => openSpeech()).toThrow("MiniMax needs a group id: set MINIMAX_GROUP_ID");
  setEnv({ TTS_PROVIDER: undefined });
  expect(() => openSpeech()).toThrow("Fish Audio needs an API key: set FISH_API_KEY");
});

test("FishSpeechSelfHosted strips /v1, omits unset auth/reference_id, and strips WAV headers", async () => {
  fake = await fakeServer({
    http: () => new Response(encodeWav(new Int16Array([11, -22, 33]), 44100)),
  });
  restore();
  restore = setEnv({
    ...CLEAN_ENV,
    TTS_PROVIDER: "fish-speech",
    FISH_SPEECH_BASE_URL: `${fake.base}/v1/`,
  });
  const stream = keep(openSpeech());
  expect(stream).toBeInstanceOf(FishSpeechSelfHosted);
  expect(stream.sampleRate).toBe(44100);
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "你好。" });
  utterance.end();
  expect(plain(await collect(utterance.audio))).toEqual([
    { kind: "pcm", seg: 1, pcm: [11, -22, 33] },
    { kind: "seg-end", seg: 1 },
    { kind: "end" },
  ]);
  const [req] = fake.requests as [HttpRequest];
  expect(req.path).toBe("/v1/tts");
  expect(req.headers.get("authorization")).toBeNull();
  expect(req.headers.get("model")).toBeNull();
  expect(JSON.parse(req.body)).toEqual({
    text: "你好。",
    format: "pcm",
    streaming: true,
    normalize: false,
  });
});

test("openai-compatible TTS allows omitted voice and optional API key", async () => {
  fake = await fakeServer({
    http: () => new Response(encodeWav(new Int16Array([7, 8]), 24000)),
  });
  restore();
  restore = setEnv({
    ...CLEAN_ENV,
    TTS_PROVIDER: "openai-compatible",
    OPENAI_COMPATIBLE_BASE_URL: `${fake.base}/v1/`,
  });
  const stream = keep(openSpeech());
  expect(stream).toBeInstanceOf(OpenAISpeech);
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "Hi." });
  utterance.end();
  expect(plain(await collect(utterance.audio))).toEqual([
    { kind: "pcm", seg: 1, pcm: [7, 8] },
    { kind: "seg-end", seg: 1 },
    { kind: "end" },
  ]);
  const [req] = fake.requests as [HttpRequest];
  expect(req.path).toBe("/v1/audio/speech");
  expect(req.headers.get("authorization")).toBeNull();
  expect(JSON.parse(req.body)).toEqual({
    input: "Hi.",
    model: "tts-1",
    response_format: "pcm",
  });
});

test("pcmBody strips WAV headers across chunk boundaries and preserves raw PCM", async () => {
  const wav = encodeWav(new Int16Array([11, -22, 33, -44]), 44100);
  // Insert a 5-byte JUNK subchunk (odd size, padded to 6 data bytes) before `data`.
  const extra = new Uint8Array([
    0x4a, 0x55, 0x4e, 0x4b, 0x03, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x00,
  ]);
  const withExtra = new Uint8Array(wav.length + extra.length);
  withExtra.set(wav.subarray(0, 36), 0);
  withExtra.set(extra, 36);
  withExtra.set(wav.subarray(36), 36 + extra.length);
  expect(stripWavHeader(withExtra)).toEqual(wav.subarray(44));

  fake = await fakeServer({
    // Split directly inside RIFF, WAVE, extra JUNK, data header, and PCM body.
    http: () =>
      streamed([
        withExtra.subarray(0, 2),
        withExtra.subarray(2, 10),
        withExtra.subarray(10, 39),
        withExtra.subarray(39, 54),
        withExtra.subarray(54),
      ]),
  });
  restore();
  restore = setEnv({
    ...CLEAN_ENV,
    TTS_PROVIDER: "fish-speech",
    FISH_SPEECH_BASE_URL: `${fake.base}`,
  });
  const stream = keep(openSpeech());
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "喂。" });
  utterance.end();
  expect(plain(await collect(utterance.audio))).toEqual([
    { kind: "pcm", seg: 1, pcm: [11, -22, 33, -44] },
    { kind: "seg-end", seg: 1 },
    { kind: "end" },
  ]);

  // Raw PCM that begins with "RI" (0x52, 0x49) passes through intact once it diverges from "RIFF".
  const collectBody = async (chunks: Uint8Array[]) => {
    const out: number[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    for await (const chunk of pcmBody(body)) out.push(...chunk);
    return out;
  };
  expect(await collectBody([new Uint8Array([0x52, 0x49]), new Uint8Array([0x00, 0x01])])).toEqual([
    0x52, 0x49, 0x00, 0x01,
  ]);
  const emptyWav = encodeWav(new Int16Array(0), 44100);
  expect(await collectBody([emptyWav.subarray(0, 22), emptyWav.subarray(22, 44)])).toEqual([]);
  await expect(collectBody([wav.subarray(0, 22), wav.subarray(22, 44)])).rejects.toThrow(
    "Truncated WAV audio",
  );

  // Malformed RIFF/WAVE streams exceeding 64 KiB without a `data` chunk stop probing and flush.
  const oversize = new Uint8Array(64 * 1024 + 16);
  oversize.set(wav.subarray(0, 12), 0);
  oversize.set([0x4a, 0x55, 0x4e, 0x4b, 0xff, 0xff, 0x01, 0x00], 12);
  const yielded: Uint8Array[] = [];
  const oversizeBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oversize);
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.close();
    },
  });
  for await (const chunk of pcmBody(oversizeBody)) yielded.push(chunk);
  expect(yielded.length).toBe(2);
  expect(yielded[0]?.length).toBe(oversize.length);
  expect(yielded[1]).toEqual(new Uint8Array([1, 2, 3, 4]));

  // Trailing RIFF metadata subchunks past the `data` extent are discarded, and bad WAV formats reject.
  const withTrailer = new Uint8Array(wav.length + 12);
  withTrailer.set(wav, 0);
  new DataView(withTrailer.buffer).setUint32(4, withTrailer.length - 8, true);
  withTrailer.set([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4], wav.length);
  expect(stripWavHeader(withTrailer)).toEqual(wav.subarray(44));
  expect(await collectBody([withTrailer.subarray(0, 48), withTrailer.subarray(48)])).toEqual([
    ...wav.subarray(44),
  ]);

  const stereo = encodeWav(new Int16Array([1, 2]), 24000, 2);
  await expect(collectBody([stereo])).rejects.toThrow(SpeechError);
  const wrongRateBody = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(wav);
      c.close();
    },
  });
  await expect(
    (async () => {
      for await (const _ of pcmBody(wrongRateBody, 24000)) {
        // drain
      }
    })(),
  ).rejects.toThrow("Unsupported WAV sample rate");
});
