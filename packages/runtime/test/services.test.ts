import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openrouterHeaders } from "@eidolon/config";
import {
  AnthropicClient,
  OpenAIChatClient,
  setUsageSink,
  type UsageRecord,
} from "@eidolon/providers";
import { AnthropicLLMService } from "@pipedog/anthropic/llm";
import { CartesiaTTSService } from "@pipedog/cartesia/tts";
import { InputAudioRawFrame } from "@pipedog/core/frames/frames";
import { FrameDirection } from "@pipedog/core/processors/frame_processor";
import { DeepgramSTTService } from "@pipedog/deepgram/stt";
import { DeepSeekLLMService } from "@pipedog/deepseek/llm";
import { ElevenLabsTTSService } from "@pipedog/elevenlabs/tts";
import { OpenAILLMService } from "@pipedog/openai/llm";
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";
import { createLlm, createRealtime, createStt, createTts } from "../src/session/services.ts";
import { captureLogs, type LogCapture, setEnv } from "./support.ts";

const KEYS = {
  SONIOX_API_KEY: "soniox-key",
  SONIOX_MODEL: undefined,
  FISH_API_KEY: "fish-key",
  FISH_VOICE_ID: "voice-default",
  FISH_MODEL: undefined,
  OPENROUTER_API_KEY: "openrouter-key",
  OPENROUTER_MODEL: undefined,
  OPENROUTER_APP_NAME: undefined,
  OPENROUTER_APP_URL: undefined,
  OPENROUTER_API_BASE: undefined,
  STT_PROVIDER: undefined,
  STT_MODEL: undefined,
  STT_LANGUAGE: undefined,
  LLM_PROVIDER: undefined,
  LLM_MODEL: undefined,
  TTS_PROVIDER: undefined,
  TTS_MODEL: undefined,
  TTS_VOICE_ID: undefined,
  TRANSCRIBE_LANGUAGE: undefined,
  ANTHROPIC_API_KEY: undefined,
  DEEPSEEK_API_KEY: undefined,
  DEEPGRAM_API_KEY: undefined,
  ELEVENLABS_API_KEY: undefined,
  CARTESIA_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  XAI_API_KEY: undefined,
  XAI_BASE_URL: undefined,
  REALTIME_PROVIDER: undefined,
  REALTIME_MODEL: undefined,
  DASHSCOPE_API_KEY: undefined,
  MINIMAX_API_KEY: undefined,
  MINIMAX_GROUP_ID: undefined,
};

let logs: LogCapture;
let restoreEnv: () => void;
beforeEach(() => {
  logs = captureLogs();
  restoreEnv = setEnv(KEYS);
});
afterEach(() => {
  restoreEnv();
  logs.restore();
  setUsageSink(null);
});

describe("createStt", () => {
  test("Soniox with the model from env and VAD-forced turn ends", () => {
    const stt = createStt() as any;
    expect(stt._apiKey).toBe("soniox-key");
    expect(stt._settings.model).toBe("stt-rt-v5");
    expect(stt._vadForceTurnEndpoint).toBe(true);
    expect(stt._settings.context ?? null).toBeNull();
    expect(stt._settings.language ?? null).toBeNull();
    setEnv({ SONIOX_MODEL: "stt-rt-v9" });
    expect((createStt() as any)._settings.model).toBe("stt-rt-v9");
    setEnv({ STT_MODEL: "stt-rt-v6" });
    expect((createStt() as any)._settings.model).toBe("stt-rt-v6");
    setEnv({ STT_MODEL: "", SONIOX_MODEL: "" });
    expect((createStt() as any)._settings.model).toBe("stt-rt-v5");
  });

  test("an empty or missing key is a session failure that names the key", () => {
    for (const value of ["", undefined]) {
      setEnv({ SONIOX_API_KEY: value });
      expect(() => createStt()).toThrow(
        "Soniox needs an API key: set SONIOX_API_KEY in credentials.json or the environment",
      );
    }
  });

  test("Deepgram hears the persona's language, her videos' when she names none", () => {
    setEnv({ STT_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "dg", SONIOX_MODEL: "stt-rt-v9" });
    const stt = createStt() as any;
    expect(stt).toBeInstanceOf(DeepgramSTTService);
    expect(stt._settings.model).toBe("nova-3-general");
    expect(stt._settings.language).toBe("zh");
    setEnv({ TRANSCRIBE_LANGUAGE: "ja" });
    expect((createStt() as any)._settings.language).toBe("ja");
    setEnv({ STT_LANGUAGE: "en" });
    expect((createStt() as any)._settings.language).toBe("en");
  });

  test("counts the audio it hears for the usage ledger, at the end of the call", async () => {
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    const metered = createStt() as any;
    // One second of 16 kHz mono 16-bit audio, counted before the service, unconnected, drops it.
    const frame = new InputAudioRawFrame({
      audio: new Uint8Array(32000),
      sampleRate: 16000,
      numChannels: 1,
    });
    await metered.processFrame(frame, FrameDirection.DOWNSTREAM).catch(() => {});
    // What a reconnect replays from its buffer was counted as it arrived.
    await metered.processAudioFrame(frame, FrameDirection.DOWNSTREAM).catch(() => {});
    await metered.cleanup().catch(() => {});
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      role: "hearing",
      provider: "soniox",
      model: "stt-rt-v5",
      units: { audioSeconds: 1 },
      costSource: "estimated",
    });
    expect(records[0]?.costUsd).toBeCloseTo(0.12 / 3600, 10);
  });
});

describe("createTts", () => {
  test("Fish at 44.1 kHz, normal latency, no normalization, drama-3 by default", () => {
    const tts = createTts() as any;
    expect(tts._apiKey).toBe("fish-key");
    expect(tts._initSampleRate).toBe(44100);
    expect(tts._stopFrameTimeoutS).toBe(15);
    expect(tts._settings.model).toBe("drama-3");
    expect(tts._settings.voice).toBe("voice-default");
    expect(tts._settings.latency).toBe("normal");
    expect(tts._settings.normalize).toBe(false);
    expect(tts._outputFormat).toBe("pcm");
    expect(tts._textFilters).toEqual([]);
    for (const field of ["prosodyNormalizeLoudness", "chunkLength", "minChunkLength"]) {
      expect(tts._settings[field] ?? null).toBeNull();
    }
    setEnv({ FISH_MODEL: "s2.1-pro" });
    expect((createTts() as any)._settings.model).toBe("s2.1-pro");
  });

  test("a blank FISH_VOICE_ID sends no reference id", () => {
    setEnv({ FISH_VOICE_ID: "" });
    expect((createTts() as any)._settings.voice).toBeNull();
    setEnv({ FISH_VOICE_ID: undefined });
    expect((createTts() as any)._settings.voice).toBeNull();
  });

  test("an empty or missing key is a session failure", () => {
    for (const value of ["", undefined]) {
      setEnv({ FISH_API_KEY: value });
      expect(() => createTts()).toThrow("Fish Audio needs an API key: set FISH_API_KEY");
    }
  });

  test("a model that can't read Drama 3's cues gets them stripped before it speaks", async () => {
    setEnv({ FISH_MODEL: "s2.1-pro" });
    const [bracketsOnly] = (createTts() as any)._textFilters;
    expect(await bracketsOnly.filter("[温柔] 好<emphasis>呀</emphasis>")).toBe("[温柔] 好呀");
    setEnv({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "el", TTS_VOICE_ID: "v1" });
    const eleven = createTts() as any;
    expect(eleven).toBeInstanceOf(ElevenLabsTTSService);
    expect(eleven._settings.model).toBe("eleven_flash_v2_5");
    expect(eleven._settings.voice).toBe("v1");
    expect(await eleven._textFilters[0].filter("[温柔] 好<emphasis>呀</emphasis>")).toBe("好呀");
  });

  test("Cartesia speaks her language; MiniMax wants its group id", () => {
    setEnv({ TTS_PROVIDER: "cartesia", CARTESIA_API_KEY: "ck", TTS_VOICE_ID: "voice" });
    const cartesia = createTts() as any;
    expect(cartesia).toBeInstanceOf(CartesiaTTSService);
    expect(cartesia._settings.language).toBe("zh");
    setEnv({ TTS_PROVIDER: "minimax", MINIMAX_API_KEY: "mk" });
    expect(() => createTts()).toThrow("MiniMax needs a group id: set MINIMAX_GROUP_ID");
    setEnv({ MINIMAX_GROUP_ID: "g1" });
    expect((createTts() as any)._baseUrl).toBe("https://api.minimax.io/v1/t2a_v2?GroupId=g1");
  });
});

describe("createLlm", () => {
  test("OpenRouter through the fetch client, with the persona and the attribution headers", () => {
    const llm = createLlm("persona text") as any;
    expect(llm).toBeInstanceOf(OpenRouterLLMService);
    expect(llm._settings.systemInstruction).toBe("persona text");
    expect(llm._settings.model).toBe("~google/gemini-flash-latest");
    expect(llm._client).toBeInstanceOf(OpenAIChatClient);
    setEnv({ OPENROUTER_MODEL: "" });
    expect((createLlm("p") as any)._settings.model).toBe("~google/gemini-flash-latest");
    setEnv({ OPENROUTER_MODEL: "x/y" });
    expect((createLlm("p") as any)._settings.model).toBe("x/y");
  });

  test("the fetch client posts where the SDK did, and reports what the turn cost", async () => {
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        seen.push({
          url: request.url,
          headers: request.headers,
          body: (await request.json()) as Record<string, unknown>,
        });
        return new Response(
          'data: {"choices":[{"delta":{"content":"嗨"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"cost":0.0002}}\n\n' +
            "data: [DONE]\n\n",
        );
      },
    });
    try {
      setEnv({ OPENROUTER_API_BASE: `http://127.0.0.1:${server.port}/api/v1` });
      const llm = createLlm("p") as any;
      const stream = await llm._client.chat.completions.create({ model: "m", stream: true });
      for await (const _ of stream) {
        // drain
      }
      expect(new URL(seen[0]?.url ?? "").pathname).toBe("/api/v1/chat/completions");
      expect(seen[0]?.headers.get("authorization")).toBe("Bearer openrouter-key");
      expect(seen[0]?.headers.get("x-title")).toBe(openrouterHeaders()["X-Title"]);
      expect(seen[0]?.body.usage).toEqual({ include: true });
      expect(records).toEqual([
        expect.objectContaining({
          role: "mind",
          provider: "openrouter",
          model: "m",
          costUsd: 0.0002,
          costSource: "reported",
        }),
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("an empty or missing key fails the session up front", () => {
    for (const value of ["", undefined]) {
      setEnv({ OPENROUTER_API_KEY: value });
      expect(() => createLlm("p")).toThrow("OpenRouter needs an API key: set OPENROUTER_API_KEY");
    }
  });

  test("Anthropic's own service, with prompt caching and refusal fallbacks", () => {
    setEnv({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "ak", OPENROUTER_MODEL: "x/y" });
    const llm = createLlm("p") as any;
    expect(llm).toBeInstanceOf(AnthropicLLMService);
    expect(llm._client).toBeInstanceOf(AnthropicClient);
    expect(llm._settings.model).toBe("claude-opus-5-5");
    expect(llm._settings.enablePromptCaching).toBe(true);
    expect(llm._settings.extra).toEqual({ fallbacks: "default" });
    setEnv({ LLM_MODEL: "claude-haiku-5-5" });
    expect((createLlm("p") as any)._settings.extra).toEqual({});
  });

  test("DeepSeek's service with thinking off, and OpenAI-compatible APIs at their base", () => {
    setEnv({ LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "dk" });
    const deepseek = createLlm("p") as any;
    expect(deepseek).toBeInstanceOf(DeepSeekLLMService);
    expect(deepseek._settings.thinking.type).toBe("disabled");
    setEnv({ LLM_PROVIDER: "google", GEMINI_API_KEY: "gk", LLM_MODEL: "gemini-3.1-flash-lite" });
    const gemini = createLlm("p") as any;
    expect(gemini).toBeInstanceOf(OpenAILLMService);
    expect(gemini._settings.extra).toEqual({ reasoning_effort: "minimal" });
    const params = gemini.buildChatCompletionParams({
      messages: [
        { role: "system", content: "persona" },
        { role: "user", content: "hi" },
        { role: "system", content: "recalled" },
      ],
    });
    expect(params.messages.map((m: { role: string }) => m.role)).toEqual([
      "system",
      "user",
      "user",
    ]);
  });

  test("recalled memories go as a developer message only to OpenAI's own API", () => {
    const developer = (env: Record<string, string>) => {
      setEnv(env);
      return (createLlm("p") as any).supportsDeveloperRole;
    };
    expect(developer({ LLM_PROVIDER: "openai", OPENAI_API_KEY: "ok" })).toBe(true);
    for (const [provider, key] of [
      ["openrouter", "OPENROUTER_API_KEY"],
      ["google", "GEMINI_API_KEY"],
      ["xai", "XAI_API_KEY"],
      ["qwen", "DASHSCOPE_API_KEY"],
    ] as const) {
      expect([provider, developer({ LLM_PROVIDER: provider, [key]: "k" })]).toEqual([
        provider,
        false,
      ]);
    }
  });
});

describe("realtime endpoints", () => {
  test("follow the account's API base, as its HTTP requests do", () => {
    setEnv({ STT_PROVIDER: "openai", OPENAI_API_KEY: "sk" });
    expect((createStt() as any)._baseUrl).toBe("wss://api.openai.com/v1/realtime");
    setEnv({ OPENAI_BASE_URL: "https://proxy.example/v1/" });
    expect((createStt() as any)._baseUrl).toBe("wss://proxy.example/v1/realtime");

    setEnv({ REALTIME_PROVIDER: "openai", OPENAI_BASE_URL: "http://127.0.0.1:8080/v1" });
    expect((createRealtime("hi") as any).baseUrl).toBe(
      "ws://127.0.0.1:8080/v1/realtime?model=gpt-realtime-2.1",
    );
    setEnv({ REALTIME_PROVIDER: "xai", XAI_API_KEY: "xk" });
    expect((createRealtime("hi") as any).baseUrl).toBe("wss://api.x.ai/v1/realtime");
    setEnv({ XAI_BASE_URL: "https://grok-proxy.example/v1" });
    expect((createRealtime("hi") as any).baseUrl).toBe("wss://grok-proxy.example/v1/realtime");
  });
});
