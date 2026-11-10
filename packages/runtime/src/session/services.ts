// A call's speech recognition, chat model and voice, from whichever providers the persona picks.
// Chat models talk through @eidolon/providers' fetch clients, handed to pipedog's services in
// place of the vendor SDKs they would otherwise build.
import { envOptional, openrouterHeaders } from "@eidolon/config";
import {
  ANTHROPIC_FALLBACK_MODELS,
  AnthropicClient,
  hasKey,
  type Markup,
  missingKey,
  modelInfo,
  OpenAIChatClient,
  realtimeVoiceOf,
  type Selection,
  select,
  selectRequired,
  stripMarkup,
  usageHook,
  voiceOf,
} from "@eidolon/providers";
import { AnthropicLLMService } from "@pipedog/anthropic/llm";
import { CartesiaTTSService } from "@pipedog/cartesia/tts";
import type { FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { LLMService } from "@pipedog/core/services/llm_service";
import { BaseTextFilter } from "@pipedog/core/utils/text/base_text_filter";
import { DeepgramSTTService } from "@pipedog/deepgram/stt";
import { DeepSeekLLMService } from "@pipedog/deepseek/llm";
import { ElevenLabsRealtimeSTTService } from "@pipedog/elevenlabs/stt";
import { ElevenLabsTTSService } from "@pipedog/elevenlabs/tts";
import { FishAudioTTSService } from "@pipedog/fish/tts";
import { MiniMaxHttpTTSService } from "@pipedog/minimax/tts";
import { OpenAILLMService } from "@pipedog/openai/llm";
import {
  AudioConfiguration,
  AudioInput,
  AudioOutput,
  InputAudioTranscription,
  SessionProperties,
} from "@pipedog/openai/realtime/events";
import { OpenAIRealtimeLLMService } from "@pipedog/openai/realtime/llm";
import { OpenAIRealtimeSTTService } from "@pipedog/openai/stt";
import { OpenAITTSService, type OpenAITTSServiceOptions } from "@pipedog/openai/tts";
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";
import { SonioxSTTService } from "@pipedog/soniox/stt";
import { SonioxTTSService } from "@pipedog/soniox/tts";
import { GrokLLMService } from "@pipedog/xai/llm";
import { SessionProperties as GrokSessionProperties } from "@pipedog/xai/realtime/events";
import { GrokRealtimeLLMService } from "@pipedog/xai/realtime/llm";
import { meterAudio, meterRealtime, meterTts } from "./metering.ts";

/** A role a call can't run without, with its key. */
function keyed(
  role: "hearing" | "mind" | "voice" | "realtime",
): Selection & { readonly apiKey: string } {
  const selection = selectRequired(role);
  if (!hasKey(selection)) throw missingKey(selection);
  return selection as Selection & { readonly apiKey: string };
}

/**
 * The language viewers speak with her, for the providers that want one: STT_LANGUAGE, else her
 * videos' language, else Mandarin. `none` lets the provider detect it.
 */
function spokenLanguage(): string | null {
  const language = envOptional("STT_LANGUAGE") ?? envOptional("TRANSCRIBE_LANGUAGE") ?? "zh";
  return language.trim().toLowerCase() === "none" ? null : language.trim();
}

/**
 * The realtime WebSocket under an account's HTTP API base, where OpenAI's and xAI's APIs put it:
 * `wss://api.openai.com/v1/realtime` for `https://api.openai.com/v1`, and a proxy's beside its own.
 */
function realtimeUrl(selection: Selection): string {
  return `${(selection.baseUrl as string).replace(/\/+$/, "").replace(/^http/, "ws")}/realtime`;
}

export function createStt(): FrameProcessor {
  const selection = keyed("hearing");
  const { apiKey, model } = selection;
  switch (selection.provider.id) {
    case "soniox": {
      // Soniox detects the language; only an explicit STT_LANGUAGE becomes a hint.
      const language = envOptional("STT_LANGUAGE");
      const settings = new SonioxSTTService.Settings({
        model,
        ...(language && language !== "none" ? { language } : {}),
      });
      return meterAudio(new SonioxSTTService({ apiKey, settings }), selection);
    }
    case "deepgram":
      return meterAudio(
        new DeepgramSTTService({
          apiKey,
          settings: new DeepgramSTTService.Settings({ model, language: spokenLanguage() }),
        }),
        selection,
      );
    case "elevenlabs":
      return meterAudio(
        new ElevenLabsRealtimeSTTService({
          apiKey,
          settings: new ElevenLabsRealtimeSTTService.Settings({
            model,
            language: spokenLanguage(),
          }),
        }),
        selection,
      );
    case "openai":
      return meterAudio(
        new OpenAIRealtimeSTTService({
          apiKey,
          baseUrl: realtimeUrl(selection),
          settings: new OpenAIRealtimeSTTService.Settings({ model, language: spokenLanguage() }),
        }),
        selection,
      );
    default:
      throw new Error(`${selection.provider.name} has no live speech recognition in Eidolon yet`);
  }
}

/** Strips the delivery cues a TTS model can't read, so it never says them aloud. */
class CueFilter extends BaseTextFilter {
  readonly #markup: Markup | undefined;

  constructor(markup: Markup | undefined) {
    super();
    this.#markup = markup;
  }

  override async filter(text: string): Promise<string> {
    return stripMarkup(text, this.#markup);
  }
}

function cueFilters(selection: Selection): CueFilter[] {
  const markup = modelInfo(selection.provider.id, "tts", selection.model)?.markup;
  return markup === "fish-drama" ? [] : [new CueFilter(markup)];
}

/** OpenAI's speech endpoint over fetch, in the shape OpenAITTSService calls its SDK client. */
class OpenAISpeechTTSService extends OpenAITTSService {
  constructor(
    options: OpenAITTSServiceOptions & { readonly apiKey: string; readonly baseUrl: string },
  ) {
    super(options);
    const { apiKey, baseUrl } = options;
    const speech = {
      create: (params: Record<string, unknown>, request: { signal?: AbortSignal } = {}) =>
        fetch(`${baseUrl.replace(/\/+$/, "")}/audio/speech`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal: request.signal ?? null,
        }),
    };
    // The field is typed as the SDK client this replaces.
    (this as any)._client = { audio: { speech } };
  }
}

export function createTts(): FrameProcessor {
  const selection = keyed("voice");
  const { apiKey, model } = selection;
  const voice = voiceOf(selection) ?? null;
  const textFilters = cueFilters(selection);
  switch (selection.provider.id) {
    case "fish":
      return meterTts(
        new FishAudioTTSService({
          apiKey,
          sampleRate: 44100,
          // Allow slow first audio; Pipecat also uses this timeout for trailing audio idle.
          // https://github.com/pipecat-ai/pipecat/blob/main/src/pipecat/services/tts_service.py
          stopFrameTimeoutS: 15.0,
          textFilters,
          settings: new FishAudioTTSService.Settings({
            voice,
            model,
            // latency="normal" is Fish's best-quality mode. Pipecat defaults to
            // "balanced", which shaves ~50-100 ms TTFB at an audible cost — the wrong
            // trade when the voice is the product.
            latency: "normal",
            // Fish's EN/ZH number normalization is on server-side by default,
            // but it reads years badly (2026 as a cardinal, not "二零二六").
            normalize: false,
          }),
        }),
        selection,
      );
    case "elevenlabs":
      return meterTts(
        new ElevenLabsTTSService({
          apiKey,
          textFilters,
          settings: new ElevenLabsTTSService.Settings({ model, voice }),
        }),
        selection,
      );
    case "cartesia":
      return meterTts(
        new CartesiaTTSService({
          apiKey,
          textFilters,
          settings: new CartesiaTTSService.Settings({ model, voice, language: spokenLanguage() }),
        }),
        selection,
      );
    case "soniox":
      return meterTts(
        new SonioxTTSService({
          apiKey,
          textFilters,
          settings: new SonioxTTSService.Settings({
            model,
            ...(voice ? { voice } : {}),
            language: spokenLanguage(),
          }),
        }),
        selection,
      );
    case "minimax": {
      const groupId = selection.options.groupId;
      if (!groupId) {
        throw new Error(
          selection.account.isDefault
            ? "MiniMax needs a group id: set MINIMAX_GROUP_ID"
            : `The ${selection.account.name} account needs a group id: set it in Settings → Providers`,
        );
      }
      return meterTts(
        new MiniMaxHttpTTSService({
          apiKey,
          groupId,
          baseUrl: `${(selection.baseUrl as string).replace(/\/+$/, "")}/t2a_v2`,
          textFilters,
          settings: new MiniMaxHttpTTSService.Settings({ model, ...(voice ? { voice } : {}) }),
        }),
        selection,
      );
    }
    case "openai":
      return meterTts(
        new OpenAISpeechTTSService({
          apiKey,
          baseUrl: selection.baseUrl as string,
          textFilters,
          settings: new OpenAITTSService.Settings({ model, ...(voice ? { voice } : {}) }),
        }),
        selection,
      );
    default:
      throw new Error(`${selection.provider.name} has no speech synthesis in Eidolon yet`);
  }
}

type ClientOptions = { readonly client?: unknown };

/** One of pipedog's OpenAI-compatible services, calling `options.client` instead of the SDK. */
function withClient<T extends new (...args: any[]) => { createClient(options?: any): any }>(
  Base: T,
) {
  return class extends Base {
    override createClient(options: ClientOptions = {}): any {
      return options.client ?? super.createClient(options);
    }
  };
}

const OpenRouterLLM = withClient(OpenRouterLLMService);
const DeepSeekLLM = withClient(DeepSeekLLMService);
const OpenAICompatibleLLM = withClient(OpenAILLMService);

// Only OpenAI's own chat API is known to take a `developer` message, which recalled memories
// arrive as; elsewhere they go as user messages, as pipedog sends them to OpenRouter and DeepSeek.
class GrokLLM extends withClient(GrokLLMService) {
  static override supportsDeveloperRole = false;
}

class CompatibleLLM extends OpenAICompatibleLLM {
  static override supportsDeveloperRole = false;
}

/**
 * Gemini's OpenAI-compatible endpoint, which, as OpenRouter's Gemini routes, takes one system
 * message: the persona's. Retrieved context arrives as later system messages and goes as user ones.
 */
class GeminiLLM extends CompatibleLLM {
  override buildChatCompletionParams(paramsFromContext: any): any {
    const params = super.buildChatCompletionParams(paramsFromContext);
    let seen = false;
    params.messages = (params.messages ?? []).map((message: { role: string }) => {
      if (message.role !== "system") return message;
      if (!seen) {
        seen = true;
        return message;
      }
      return { ...message, role: "user" };
    });
    return params;
  }
}

export function createLlm(systemInstruction: string): LLMService<any> {
  const selection = keyed("mind");
  const { apiKey, model, provider } = selection;
  const baseUrl = selection.baseUrl as string;
  const onUsage = usageHook("mind", provider.id);
  const live = modelInfo(provider.id, "llm", model)?.live ?? {};
  if (provider.id === "anthropic") {
    return new AnthropicLLMService({
      apiKey,
      client: new AnthropicClient({ provider: provider.name, baseUrl, apiKey, onUsage }),
      settings: new AnthropicLLMService.Settings({
        model,
        systemInstruction,
        enablePromptCaching: true,
        extra: {
          ...live,
          ...(ANTHROPIC_FALLBACK_MODELS.has(model) ? { fallbacks: "default" } : {}),
        },
      }),
    });
  }
  const headers = provider.id === "openrouter" ? openrouterHeaders() : {};
  const client = new OpenAIChatClient({
    provider: provider.name,
    baseUrl,
    apiKey,
    headers,
    onUsage,
    ...(provider.id === "openrouter"
      ? { extraBody: { usage: { include: true } }, reportsCost: true }
      : {}),
  });
  const common = { apiKey, baseUrl, client, defaultHeaders: headers };
  switch (provider.id) {
    case "openrouter":
      return new OpenRouterLLM({
        ...common,
        settings: new OpenRouterLLMService.Settings({ model, systemInstruction, extra: live }),
      });
    case "deepseek":
      return new DeepSeekLLM({
        ...common,
        settings: new DeepSeekLLMService.Settings({ model, systemInstruction, extra: live }),
      });
    case "xai":
      return new GrokLLM({
        ...common,
        settings: new GrokLLMService.Settings({ model, systemInstruction, extra: live }),
      });
    case "google":
      return new GeminiLLM({
        ...common,
        settings: new OpenAILLMService.Settings({ model, systemInstruction, extra: live }),
      });
    default: {
      const Service = provider.id === "openai" ? OpenAICompatibleLLM : CompatibleLLM;
      return new Service({
        ...common,
        settings: new OpenAILLMService.Settings({ model, systemInstruction, extra: live }),
      });
    }
  }
}

/** Whether the persona's calls run on one realtime model instead of hearing, mind and voice. */
export function isRealtime(): boolean {
  return select("realtime") !== null;
}

/** OpenAI's model that transcribes what the viewer says, for the transcript and memory. */
const REALTIME_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";

/** The realtime model that hears, thinks and speaks for her, while `isRealtime()`. */
export function createRealtime(systemInstruction: string): LLMService<any> {
  const selection = keyed("realtime");
  const { apiKey, model, provider } = selection;
  const voice = realtimeVoiceOf(selection) ?? null;
  switch (provider.id) {
    case "openai":
      return meterRealtime(
        new OpenAIRealtimeLLMService({
          apiKey,
          baseUrl: realtimeUrl(selection),
          settings: new OpenAIRealtimeLLMService.Settings({
            model,
            systemInstruction,
            sessionProperties: new SessionProperties({
              audio: new AudioConfiguration({
                input: new AudioInput({
                  transcription: new InputAudioTranscription({
                    model: REALTIME_TRANSCRIPTION_MODEL,
                    language: spokenLanguage(),
                  }),
                }),
                output: new AudioOutput({ voice }),
              }),
            }),
          }),
        }),
        selection,
      );
    case "xai":
      return meterRealtime(
        new GrokRealtimeLLMService({
          apiKey,
          baseUrl: realtimeUrl(selection),
          settings: new GrokRealtimeLLMService.Settings({
            model,
            systemInstruction,
            sessionProperties: new GrokSessionProperties({ voice }),
          }),
        }),
        selection,
      );
    default:
      throw new Error(`${provider.name} has no realtime voice model in Eidolon yet`);
  }
}
