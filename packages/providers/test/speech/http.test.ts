import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { setUsageSink, type UsageRecord } from "../../src/index.ts";
import { openSpeech, type SpeechStream } from "../../src/speech/stream/index.ts";
import { MiniMaxSpeech } from "../../src/speech/stream/minimax.ts";
import { OpenAISpeech } from "../../src/speech/stream/openai.ts";
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
  fake?.stop();
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
          await Bun.sleep(pauseMs);
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
  fake = fakeServer({ http: () => streamed(pieces(minimaxBody([1, 2, 3]), [7, 33, 61])) });
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
  fake = fakeServer({
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
  await Bun.sleep(30);
  expect(fake.requests.map((request) => JSON.parse(request.body).input)).toEqual(["一。", "二。"]);
  held[1]?.(new Response(bytesOf([30, 31])));
  await Bun.sleep(30);
  expect(held).toHaveLength(3);
  held[2]?.(new Response(bytesOf([40])));
  held[0]?.(streamed([bytesOf([10]), bytesOf([11])]));
  expect(plain(await collect(utterance.audio))).toEqual([
    { kind: "pcm", seg: 1, pcm: [10] },
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
  fake = fakeServer({
    http: () => streamed([pcm.subarray(0, 3), pcm.subarray(3, 5), pcm.subarray(5)]),
  });
  const stream = keep(new OpenAISpeech(selectionAt("openai", `${fake.base}/v1`)));
  const utterance = stream.utterance(null);
  utterance.say({ id: 1, text: "你好。" });
  utterance.end();
  expect(plain(await collect(utterance.audio))).toEqual([
    { kind: "pcm", seg: 1, pcm: [1000] },
    { kind: "pcm", seg: 1, pcm: [-1000] },
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
  fake = fakeServer({
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
  await Bun.sleep(20);
  expect(fake.requests).toHaveLength(1);

  fake.stop();
  fake = fakeServer({ http: () => new Response("", { status: 500 }) });
  const minimax = keep(new MiniMaxSpeech(selectionAt("minimax", fake.base, {}, { groupId: "g" })));
  const failing = minimax.utterance(null);
  failing.say({ id: 1, text: "嗨。" });
  expect(await collect(failing.audio)).toEqual([
    { kind: "error", message: "MiniMax TTS error: HTTP 500" },
  ]);
});

test("MiniMax: a refusal answered 200, whole or mid-stream, is an error", async () => {
  fake = fakeServer({
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
  // No `until` here: the fake clock holds Bun.sleep too.
  jest.useFakeTimers();
  try {
    const body = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const unanswered = Promise.withResolvers<void>();
    fake = fakeServer({
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
    jest.advanceTimersByTime(15_000);
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
    jest.advanceTimersByTime(10_000);
    sending.enqueue(bytesOf([2]));
    expect(await next()).toEqual({ kind: "pcm", seg: 1, pcm: [2] });
    jest.advanceTimersByTime(10_000);
    sending.enqueue(bytesOf([3]));
    expect(await next()).toEqual({ kind: "pcm", seg: 1, pcm: [3] });
    jest.advanceTimersByTime(15_000);
    expect(await next()).toEqual({
      kind: "error",
      message: "No speech audio arrived within 15 seconds",
    });
  } finally {
    jest.useRealTimers();
  }
});

test("an unknown OpenAI voice fails before any request", async () => {
  fake = fakeServer({ http: () => new Response(bytesOf([1])) });
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
  fake = fakeServer({ http: () => new Promise<Response>(() => {}) });
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
  fake = fakeServer({ http: () => new Response(bytesOf([5])) });
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
