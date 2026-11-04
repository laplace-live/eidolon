import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openrouterHeaders } from "@eidolon/config";
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";
import { createLlm, createStt, createTts } from "../src/session/services.ts";
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
});

describe("createStt", () => {
  test("Soniox with the model from env and VAD-forced turn ends", () => {
    const stt = createStt() as any;
    expect(stt._apiKey).toBe("soniox-key");
    expect(stt._settings.model).toBe("stt-rt-v5");
    expect(stt._vadForceTurnEndpoint).toBe(true);
    expect(stt._settings.context ?? null).toBeNull();
    setEnv({ SONIOX_MODEL: "stt-rt-v9" });
    expect((createStt() as any)._settings.model).toBe("stt-rt-v9");
    setEnv({ SONIOX_MODEL: "" });
    expect((createStt() as any)._settings.model).toBe("stt-rt-v5");
  });

  test("an empty or missing key is a session failure", () => {
    for (const value of ["", undefined]) {
      setEnv({ SONIOX_API_KEY: value });
      expect(() => createStt()).toThrow("SONIOX_API_KEY environment variable is required");
    }
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
      expect(() => createTts()).toThrow("FISH_API_KEY environment variable is required");
    }
  });
});

describe("createLlm", () => {
  test("OpenRouter with the persona in settings and the attribution headers", () => {
    const llm = createLlm("persona text") as any;
    expect(llm).toBeInstanceOf(OpenRouterLLMService);
    expect(llm._settings.systemInstruction).toBe("persona text");
    expect(llm._settings.model).toBe("~google/gemini-flash-latest");
    expect(llm._client.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(llm._client._options.defaultHeaders).toEqual(openrouterHeaders());
    expect(llm._client.apiKey).toBe("openrouter-key");
    setEnv({ OPENROUTER_MODEL: "" });
    expect((createLlm("p") as any)._settings.model).toBe("~google/gemini-flash-latest");
    setEnv({ OPENROUTER_MODEL: "x/y" });
    expect((createLlm("p") as any)._settings.model).toBe("x/y");
  });

  test("an empty or missing key fails the session up front", () => {
    for (const value of ["", undefined]) {
      setEnv({ OPENROUTER_API_KEY: value });
      expect(() => createLlm("p")).toThrow("OPENROUTER_API_KEY environment variable is required");
    }
  });
});
