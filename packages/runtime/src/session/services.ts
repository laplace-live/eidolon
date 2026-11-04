import { envOptional, envStr, openrouterHeaders } from "@eidolon/config";
import { FishAudioTTSService } from "@pipedog/fish/tts";
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";
import { SonioxSTTService } from "@pipedog/soniox/stt";

function requiredEnv(name: string): string {
  const value = envOptional(name);
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

export function createStt(): SonioxSTTService {
  return new SonioxSTTService({
    apiKey: requiredEnv("SONIOX_API_KEY"),
    settings: new SonioxSTTService.Settings({ model: envStr("SONIOX_MODEL", "stt-rt-v5") }),
  });
}

export function createTts(): FishAudioTTSService {
  return new FishAudioTTSService({
    apiKey: requiredEnv("FISH_API_KEY"),
    sampleRate: 44100,
    // Allow slow first audio; Pipecat also uses this timeout for trailing audio idle.
    // https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/services/tts_service.py
    stopFrameTimeoutS: 15.0,
    settings: new FishAudioTTSService.Settings({
      voice: envOptional("FISH_VOICE_ID") ?? null,
      model: envStr("FISH_MODEL", "drama-3"),
      // latency="normal" is Fish's best-quality mode. Pipecat defaults to
      // "balanced", which shaves ~50-100 ms TTFB at an audible cost — the wrong
      // trade when the voice is the product.
      latency: "normal",
      // Fish's EN/ZH number normalization is on server-side by default,
      // but it reads years badly (2026 as a cardinal, not "二零二六").
      normalize: false,
    }),
  });
}

export function createLlm(systemInstruction: string): OpenRouterLLMService {
  return new OpenRouterLLMService({
    apiKey: requiredEnv("OPENROUTER_API_KEY"),
    settings: new OpenRouterLLMService.Settings({
      model: envStr("OPENROUTER_MODEL", "~google/gemini-flash-latest"),
      systemInstruction,
    }),
    defaultHeaders: openrouterHeaders(),
  });
}
