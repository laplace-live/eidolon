import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ProviderConfigError, ProviderHttpError, selectRequired } from "../../../src/index.ts";
import { speechSupport, synthesize } from "../../../src/speech/batch/index.ts";
import { FakeProvider, hex, mp3Frames, sources } from "./fake.ts";

const fake = new FakeProvider();
beforeAll(() => fake.start());
afterAll(() => fake.stop());

const audio = mp3Frames(10);
const mp3 = () => new Response(audio, { headers: { "Content-Type": "audio/mpeg" } });
// 10 frames of 1152 samples at 44.1 kHz.
const AUDIO_MS = 261;

const voice = (vars: Readonly<Record<string, string>>) => selectRequired("voice", sources(vars));

const LINE = "[轻笑] 你来啦<emphasis>欢迎</emphasis>";

describe("synthesize", () => {
  test("Fish gets drama-3's markup as written, in the role's voice, as MP3", async () => {
    fake.answer(mp3);
    const speech = await synthesize(voice({ FISH_API_KEY: "fk" }), LINE, {
      voice: "ref-1",
      fetch: fake.fetch,
    });
    expect(speech).toEqual({ bytes: audio, mime: "audio/mpeg", durationMs: AUDIO_MS });
    const [request] = fake.seen;
    expect(request?.url).toBe("https://api.fish.audio/v1/tts");
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer fk");
    expect(request?.headers.get("model")).toBe("drama-3");
    expect(request?.json).toEqual({
      text: LINE,
      reference_id: "ref-1",
      format: "mp3",
      mp3_bitrate: 128,
      latency: "normal",
      normalize: false,
    });
    expect(fake.usage).toHaveLength(1);
    expect(fake.usage[0]).toMatchObject({
      role: "voice",
      category: "tts",
      provider: "fish",
      model: "drama-3",
      units: { characters: [...LINE].length, bytes: new TextEncoder().encode(LINE).length },
      costSource: "estimated",
    });
  });

  test("Fish without a voice leaves the reference out, and a model without markup loses it", async () => {
    fake.answer(mp3);
    await synthesize(voice({ FISH_API_KEY: "fk", TTS_MODEL: "s1" }), LINE, { fetch: fake.fetch });
    expect(fake.seen[0]?.json).toMatchObject({ text: "你来啦欢迎" });
    expect(fake.seen[0]?.json).not.toHaveProperty("reference_id");
    expect(fake.seen[0]?.headers.get("model")).toBe("s1");
  });

  test("the voice is the role's, from TTS_VOICE_ID, unless the reply names its own", async () => {
    fake.answer(mp3);
    process.env.TTS_VOICE_ID = "persona-voice";
    try {
      await synthesize(voice({ FISH_API_KEY: "fk" }), "嗨", { fetch: fake.fetch });
      await synthesize(voice({ FISH_API_KEY: "fk" }), "嗨", { voice: "gentle", fetch: fake.fetch });
    } finally {
      delete process.env.TTS_VOICE_ID;
    }
    expect(fake.seen.map((seen) => (seen.json as { reference_id: string }).reference_id)).toEqual([
      "persona-voice",
      "gentle",
    ]);
  });

  test("OpenAI speaks cue-free text at the account's base, in the catalog's default voice", async () => {
    fake.answer(mp3);
    const selection = voice({
      TTS_PROVIDER: "openai",
      OPENAI_API_KEY: "ok",
      OPENAI_BASE_URL: "https://proxy.example/v1/",
    });
    await synthesize(selection, LINE, { fetch: fake.fetch });
    const [request] = fake.seen;
    expect(request?.url).toBe("https://proxy.example/v1/audio/speech");
    expect(request?.headers.get("authorization")).toBe("Bearer ok");
    expect(request?.json).toEqual({
      model: "gpt-4o-mini-tts",
      input: "你来啦欢迎",
      voice: "marin",
      response_format: "mp3",
    });
    expect(fake.usage[0]).toMatchObject({
      role: "voice",
      provider: "openai",
      units: { characters: 5 },
      costSource: "unpriced",
    });
  });

  test("ElevenLabs puts the voice in the path, and eleven_v3 keeps its bracket tags", async () => {
    fake.answer(mp3);
    const selection = voice({
      TTS_PROVIDER: "elevenlabs",
      TTS_MODEL: "eleven_v3",
      ELEVENLABS_API_KEY: "xk",
    });
    await synthesize(selection, LINE, { voice: "v/1", fetch: fake.fetch });
    const [request] = fake.seen;
    expect(request?.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/v%2F1?output_format=mp3_44100_128",
    );
    expect(request?.headers.get("xi-api-key")).toBe("xk");
    expect(request?.json).toEqual({ text: "[轻笑] 你来啦欢迎", model_id: "eleven_v3" });
    expect(fake.usage[0]).toMatchObject({ units: { characters: 10 }, costSource: "estimated" });
  });

  test("Cartesia asks for MP3 bytes in the spoken language, with its version header", async () => {
    fake.answer(mp3);
    process.env.STT_LANGUAGE = "ja";
    try {
      await synthesize(voice({ TTS_PROVIDER: "cartesia", CARTESIA_API_KEY: "ck" }), "やあ", {
        voice: "c-voice",
        fetch: fake.fetch,
      });
    } finally {
      delete process.env.STT_LANGUAGE;
    }
    const [request] = fake.seen;
    expect(request?.url).toBe("https://api.cartesia.ai/tts/bytes");
    expect(request?.headers.get("x-api-key")).toBe("ck");
    expect(request?.headers.get("cartesia-version")).toBe("2026-03-01");
    expect(request?.json).toEqual({
      model_id: "sonic-3.6",
      transcript: "やあ",
      voice: { mode: "id", id: "c-voice" },
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      language: "ja",
    });
  });

  test("Soniox synthesizes at its own host, in pipedog's default voice and Mandarin", async () => {
    fake.answer(mp3);
    await synthesize(voice({ TTS_PROVIDER: "soniox", SONIOX_API_KEY: "sk" }), "你好", {
      fetch: fake.fetch,
    });
    const [request] = fake.seen;
    expect(request?.url).toBe("https://tts-rt.soniox.com/tts");
    expect(request?.headers.get("authorization")).toBe("Bearer sk");
    expect(request?.json).toEqual({
      model: "tts-rt-v2",
      voice: "Bryce",
      text: "你好",
      audio_format: "mp3",
      language: "zh",
    });
  });

  test("MiniMax's hex audio is decoded, with the length it reports", async () => {
    fake.answer(() =>
      Response.json({
        data: { audio: hex(audio), status: 2 },
        extra_info: { audio_length: 1234 },
        base_resp: { status_code: 0, status_msg: "success" },
      }),
    );
    const selection = voice({
      TTS_PROVIDER: "minimax",
      MINIMAX_API_KEY: "mk",
      MINIMAX_GROUP_ID: "g 1",
    });
    const speech = await synthesize(selection, "你好", { fetch: fake.fetch });
    expect(speech).toEqual({ bytes: audio, mime: "audio/mpeg", durationMs: 1234 });
    const [request] = fake.seen;
    expect(request?.url).toBe("https://api.minimax.io/v1/t2a_v2?GroupId=g%201");
    expect(request?.headers.get("authorization")).toBe("Bearer mk");
    expect(request?.json).toEqual({
      model: "speech-2.8-turbo",
      text: "你好",
      stream: false,
      voice_setting: { voice_id: "Calm_Woman", speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
      output_format: "hex",
    });
    expect(fake.usage[0]).toMatchObject({ provider: "minimax", units: { characters: 2 } });
  });

  test("MiniMax's refusal inside a 200 is an error, and nothing is reported as used", async () => {
    fake.answer(() => Response.json({ base_resp: { status_code: 1004, status_msg: "bad key" } }));
    const selection = voice({
      TTS_PROVIDER: "minimax",
      MINIMAX_API_KEY: "mk",
      MINIMAX_GROUP_ID: "g",
    });
    const failed = synthesize(selection, "你好", { fetch: fake.fetch });
    await expect(failed).rejects.toThrow("MiniMax answered 200: bad key (1004)");
    await expect(failed).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fake.usage).toEqual([]);
  });

  test("an error status becomes ProviderHttpError, with the provider's message", async () => {
    fake.answer(() => Response.json({ status: 402, message: "no credit" }, { status: 402 }));
    const failed = synthesize(voice({ FISH_API_KEY: "fk" }), "嗨", { fetch: fake.fetch });
    await expect(failed).rejects.toThrow("Fish Audio answered 402: no credit");
    const error = await failed.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).status).toBe(402);
    expect(fake.usage).toEqual([]);
  });

  test("refuses before any request: no key, no group id, no voice, or nothing to say", async () => {
    fake.answer(mp3);
    const refusals = [
      synthesize(voice({}), "嗨", { fetch: fake.fetch }),
      synthesize(voice({ TTS_PROVIDER: "minimax", MINIMAX_API_KEY: "mk" }), "嗨", {
        fetch: fake.fetch,
      }),
      synthesize(voice({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "xk" }), "嗨", {
        fetch: fake.fetch,
      }),
      synthesize(voice({ TTS_PROVIDER: "openai", OPENAI_API_KEY: "ok" }), "[笑]", {
        fetch: fake.fetch,
      }),
    ];
    const errors = await Promise.all(
      refusals.map((p) =>
        p.then(
          () => new Error("spoke"),
          (e: unknown) => e as Error,
        ),
      ),
    );
    expect(errors.map((error) => error.message)).toEqual([
      "Fish Audio needs an API key: set FISH_API_KEY in credentials.json or the environment",
      "MiniMax needs a group id: set MINIMAX_GROUP_ID",
      "ElevenLabs needs a voice: set TTS_VOICE_ID, or pick one in her voice settings",
      "Nothing to say: the reply holds no words to speak",
    ]);
    expect(errors.slice(0, 3).every((error) => error instanceof ProviderConfigError)).toBe(true);
    expect(fake.seen).toEqual([]);
    expect(fake.usage).toEqual([]);
  });

  test("an aborted request rejects with the caller's reason", async () => {
    fake.answer(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const pending = synthesize(voice({ FISH_API_KEY: "fk" }), "嗨", {
      fetch: fake.fetch,
      signal: controller.signal,
    });
    controller.abort(new Error("interrupted"));
    await expect(pending).rejects.toThrow("interrupted");
    expect(fake.usage).toEqual([]);
  });
});

describe("speechSupport", () => {
  test("every TTS in the catalog synthesizes; a hearing role only transcribes", () => {
    for (const provider of ["fish", "openai", "elevenlabs", "cartesia", "minimax", "soniox"]) {
      expect([provider, speechSupport(voice({ TTS_PROVIDER: provider }))]).toEqual([
        provider,
        { synthesize: true, transcribe: false },
      ]);
    }
    const hearing = selectRequired("hearing", sources({ STT_PROVIDER: "deepgram" }));
    expect(speechSupport(hearing)).toEqual({ synthesize: false, transcribe: true });
  });

  test("synthesizing with a hearing role is refused", async () => {
    const hearing = selectRequired("hearing", sources({ SONIOX_API_KEY: "sk" }));
    await expect(synthesize(hearing, "嗨", { fetch: fake.fetch })).rejects.toThrow(
      "Soniox has no batch speech synthesis",
    );
  });
});
