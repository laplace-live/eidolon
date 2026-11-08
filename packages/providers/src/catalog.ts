// Every provider Eidolon can call, what each offers, and the roles a persona fills with them. Keep
// this module import-free: the web app imports it (`@eidolon/providers/catalog`) without Bun or
// Node. Prices are the providers' published pay-as-you-go rates; a model priced by plan, by audio
// tokens Eidolon can't count, or not at all is recorded unpriced, with its usage.

/** What a model does. A realtime model hears, thinks and speaks in one session. */
export const CATEGORIES = [
  "llm",
  "stt",
  "tts",
  "realtime",
  "embedding",
  "rerank",
  "decision",
  "image",
  "transcription",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const PROVIDER_IDS = [
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "xai",
  "qwen",
  "moonshot",
  "zhipu",
  "ollama",
  "openai-compatible",
  "soniox",
  "fish",
  "elevenlabs",
  "deepgram",
  "cartesia",
  "minimax",
  "cohere",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** USD per million units, except searches (per thousand) and images (each). */
export type Price =
  | {
      readonly unit: "tokens";
      readonly input: number;
      readonly output: number;
      readonly cacheRead?: number;
      readonly cacheWrite?: number;
    }
  | { readonly unit: "characters"; readonly usd: number }
  | { readonly unit: "bytes"; readonly usd: number }
  | { readonly unit: "audio-hours"; readonly usd: number }
  | { readonly unit: "searches"; readonly usd: number }
  | { readonly unit: "images"; readonly usd: number };

/**
 * The delivery cues a TTS model reads as directions rather than words: Fish Drama 3's `[…]`
 * directions and `<emphasis>`/`<whisper>` tags, or `[…]` audio tags alone. Text for any other
 * model has them stripped before it is spoken.
 */
export type Markup = "fish-drama" | "brackets";

export interface Model {
  readonly id: string;
  /** A language limit, a deprecation, how its price is estimated. */
  readonly note?: string;
  readonly price?: Price;
  /** A lower price until an instant, ISO 8601. */
  readonly promo?: { readonly price: Price; readonly until: string };
  /**
   * Request fields for a live call, where the first word's latency matters: thinking off, or as
   * low as the model allows.
   */
  readonly live?: Readonly<Record<string, unknown>>;
  /** The same model through OpenRouter, for a model listed under its maker. */
  readonly openrouter?: string;
  readonly markup?: Markup;
  /** An embedding model's largest output dimension. */
  readonly maxDim?: number;
}

/** How a voice is named: Fish's public library, a provider's voice id, or a fixed set. */
export type VoiceCatalog =
  | { readonly kind: "fish-library" }
  | { readonly kind: "id"; readonly libraryUrl: string; readonly default?: string }
  | { readonly kind: "preset"; readonly voices: readonly string[]; readonly default: string };

/** How audio moves between the bot and the provider, for STT, TTS and realtime offers. */
export type Transport = "websocket" | "http-stream";

export interface Offer {
  /** null: the user has to name one, as for an endpoint of their own. */
  readonly defaultModel: string | null;
  /** The models Eidolon knows a price or call-time fields for; pickers list the provider's own. */
  readonly models: readonly Model[];
  /**
   * False when the provider takes only these ids and has no listing, so the local app offers a
   * choice among them rather than a text field.
   */
  readonly openModels: boolean;
  /** Where to browse the provider's models. */
  readonly modelsUrl?: string;
  readonly transport?: Transport;
  readonly voices?: VoiceCatalog;
  /** Listed, but the runtime's support has not held a real call yet. */
  readonly experimental?: boolean;
}

/** A free request only a valid key passes: a listing, never a model call. */
export interface KeyCheck {
  /** Appended to the provider's API base. */
  readonly path: string;
  /** How the key travels: `Authorization: Bearer`, `Authorization: Token`, or a header of its own. */
  readonly auth: "bearer" | "token" | "x-api-key" | "xi-api-key";
  readonly headers?: Readonly<Record<string, string>>;
}

/** A setting of the provider's own that an account carries beside its key and API base. */
export interface ProviderField {
  /** Its key in an account's `options`. */
  readonly key: string;
  /** The variable that sets it for the provider's default account. */
  readonly env: string;
  /** English, for messages; the local app names it in the viewer's language. */
  readonly label: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly url: string;
  /** Where to create a key. */
  readonly keyUrl: string | null;
  /** Where to add the credit it bills. */
  readonly billingUrl: string | null;
  /** The variable holding its default account's key; null for a provider that takes none. */
  readonly credential: string | null;
  /** Takes a key only where the server asks for one, as a server of your own may not. */
  readonly keyOptional?: boolean;
  /** The HTTP API base, for the offers that call one. */
  readonly baseUrl: string | null;
  /**
   * The variable that moves the default account's `baseUrl`: a proxy, another region, a server.
   * Null where nothing can move it, as for a provider that streams from hosts of its own, so its
   * other accounts take no base either.
   */
  readonly baseUrlEnv: string | null;
  /** Settings of its own an account carries. */
  readonly fields?: readonly ProviderField[];
  readonly offers: Readonly<Partial<Record<Category, Offer>>>;
  /** Runs on your own machine, so no request costs anything. */
  readonly free?: boolean;
  /** How the local app checks a key it is given, where the provider offers a way. */
  readonly check?: KeyCheck;
}

/** The Messages API version Anthropic requests name. It rejects temperature, top_p and top_k. */
export const ANTHROPIC_VERSION = "2026-10-21";

const tokens = (input: number, output: number, cacheRead?: number, cacheWrite?: number): Price => ({
  unit: "tokens",
  input,
  output,
  ...(cacheRead === undefined ? {} : { cacheRead }),
  ...(cacheWrite === undefined ? {} : { cacheWrite }),
});

const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

const OPENAI_REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
] as const;

export const PROVIDERS: readonly Provider[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    url: "https://openrouter.ai",
    keyUrl: "https://openrouter.ai/settings/keys",
    billingUrl: "https://openrouter.ai/settings/credits",
    credential: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEnv: "OPENROUTER_API_BASE",
    offers: {
      llm: {
        defaultModel: "~google/gemini-flash-latest",
        openModels: true,
        modelsUrl: "https://openrouter.ai/models",
        models: [
          { id: "~google/gemini-flash-latest" },
          { id: "~anthropic/claude-sonnet-latest" },
          { id: "anthropic/claude-haiku-5.5" },
          { id: "~deepseek/deepseek-flash-latest" },
          { id: "~openai/gpt-luna-latest" },
          { id: "~x-ai/grok-latest" },
          { id: "~moonshotai/kimi-latest" },
          { id: "~z-ai/glm-latest" },
          { id: "qwen/qwen3.8-flash" },
        ],
      },
      embedding: {
        defaultModel: "google/gemini-embedding-2-preview",
        openModels: true,
        modelsUrl: "https://openrouter.ai/models?output_modalities=embeddings",
        models: [
          { id: "google/gemini-embedding-2-preview", maxDim: 3072, price: tokens(0.15, 0) },
          { id: "openai/text-embedding-3-large", maxDim: 3072, price: tokens(0.13, 0) },
          { id: "openai/text-embedding-3-small", maxDim: 1536, price: tokens(0.02, 0) },
          { id: "qwen/qwen3-embedding-8b", maxDim: 4096 },
        ],
      },
      rerank: {
        defaultModel: "cohere/rerank-4-fast",
        openModels: true,
        modelsUrl: "https://openrouter.ai/models?output_modalities=rerank",
        models: [
          { id: "cohere/rerank-4-fast" },
          { id: "cohere/rerank-4-pro" },
          { id: "cohere/rerank-5-fast" },
          { id: "mongodb/rerank-3" },
          { id: "qwen/qwen3-reranker-8b" },
        ],
      },
      decision: {
        defaultModel: "~typesafe/jev-latest",
        openModels: true,
        modelsUrl: "https://openrouter.ai/models?output_modalities=decisions",
        models: [
          { id: "~typesafe/jev-latest", price: tokens(0.042, 0) },
          { id: "typesafe/jev-1.13", price: tokens(0.042, 0) },
          { id: "morph/reflex", price: tokens(0.042, 0, 0.008) },
          { id: "~liquid/d1-latest", price: tokens(0.02, 0, 0.02) },
          { id: "~perplexity/pplx-decider-latest", price: tokens(0.019, 0) },
          { id: "baseten/joey-1", price: tokens(0.01, 0) },
          { id: "cloudflare/clef-flash", price: tokens(0.038, 0) },
          { id: "upstage/solar-decide-flash", price: tokens(0.05, 0, 0.05) },
        ],
      },
      image: {
        defaultModel: "openai/gpt-image-2.5-flare",
        openModels: true,
        modelsUrl: "https://openrouter.ai/models?output_modalities=image",
        models: [{ id: "openai/gpt-image-2.5-flare" }, { id: "google/gemini-3.1-flash-image" }],
      },
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    url: "https://platform.openai.com",
    keyUrl: "https://platform.openai.com/api-keys",
    billingUrl: "https://platform.openai.com/settings/organization/billing/overview",
    credential: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    check: { path: "/models", auth: "bearer" },
    offers: {
      llm: {
        defaultModel: "gpt-6-luna",
        openModels: true,
        modelsUrl: "https://platform.openai.com/docs/models",
        models: [
          {
            id: "gpt-6-luna",
            openrouter: "openai/gpt-6-luna",
            price: tokens(0.1, 0.5, 0.01, 0.125),
            live: { reasoning_effort: "none" },
          },
          {
            id: "gpt-6.1-terra",
            openrouter: "openai/gpt-6.1-terra",
            price: tokens(1, 5, 0.05, 1.25),
          },
          { id: "gpt-6.1-sol", openrouter: "openai/gpt-6.1-sol", price: tokens(2, 10, 0.1, 2.5) },
        ],
      },
      stt: {
        defaultModel: "gpt-realtime-whisper",
        openModels: true,
        transport: "websocket",
        models: [
          { id: "gpt-realtime-whisper", price: { unit: "audio-hours", usd: 1.02 } },
          { id: "gpt-4o-transcribe" },
          { id: "gpt-4o-mini-transcribe" },
        ],
      },
      tts: {
        defaultModel: "gpt-4o-mini-tts",
        openModels: true,
        transport: "http-stream",
        voices: { kind: "preset", voices: OPENAI_VOICES, default: "marin" },
        models: [{ id: "gpt-4o-mini-tts" }],
      },
      realtime: {
        defaultModel: "gpt-realtime-2.1",
        openModels: true,
        transport: "websocket",
        experimental: true,
        voices: { kind: "preset", voices: OPENAI_REALTIME_VOICES, default: "marin" },
        models: [
          {
            id: "gpt-realtime-2.1",
            note: "Estimated at its audio token prices",
            price: tokens(32, 64, 0.4),
          },
          {
            id: "gpt-realtime-2.1-mini",
            note: "Estimated at its audio token prices",
            price: tokens(10, 20, 0.3),
          },
        ],
      },
      embedding: {
        defaultModel: "text-embedding-3-large",
        openModels: true,
        models: [
          { id: "text-embedding-3-large", maxDim: 3072, price: tokens(0.13, 0) },
          { id: "text-embedding-3-small", maxDim: 1536, price: tokens(0.02, 0) },
        ],
      },
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    url: "https://platform.claude.com",
    keyUrl: "https://platform.claude.com/settings/keys",
    billingUrl: "https://platform.claude.com/settings/billing",
    credential: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    check: {
      path: "/models",
      auth: "x-api-key",
      headers: { "anthropic-version": ANTHROPIC_VERSION },
    },
    offers: {
      llm: {
        defaultModel: "claude-opus-5-5",
        openModels: true,
        modelsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
        models: [
          {
            id: "claude-opus-5-5",
            openrouter: "anthropic/claude-opus-5.5",
            price: tokens(4, 20, 0.2, 5),
          },
          {
            id: "claude-sonnet-5-5",
            openrouter: "anthropic/claude-sonnet-5.5",
            price: tokens(2, 10, 0.2, 2.5),
          },
          {
            id: "claude-haiku-5-5",
            openrouter: "anthropic/claude-haiku-5.5",
            note: "Prompts over 100K tokens cost $0.50/$2.50 per million",
            price: tokens(0.1, 0.5, 0.01, 0.125),
          },
          {
            id: "claude-fable-5-1",
            openrouter: "anthropic/claude-fable-5.1",
            price: tokens(10, 50, 0.25, 12.5),
          },
        ],
      },
    },
  },
  {
    id: "google",
    name: "Google Gemini",
    url: "https://aistudio.google.com",
    keyUrl: "https://aistudio.google.com/apikey",
    billingUrl: "https://aistudio.google.com/usage",
    credential: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    baseUrlEnv: "GEMINI_BASE_URL",
    check: { path: "/models", auth: "bearer" },
    offers: {
      llm: {
        defaultModel: "gemini-3.8-flash",
        openModels: true,
        modelsUrl: "https://aistudio.google.com/docs/models",
        models: [
          {
            id: "gemini-3.8-flash",
            openrouter: "google/gemini-3.8-flash",
            price: tokens(1.5, 7.5, 0.15),
            promo: { price: tokens(0.75, 3.75, 0.075), until: "2027-01-01T00:00:00Z" },
          },
          {
            id: "gemini-3.1-flash-lite",
            openrouter: "google/gemini-3.1-flash-lite",
            price: tokens(0.25, 1.5, 0.025),
            live: { reasoning_effort: "minimal" },
          },
          {
            id: "gemini-4-argon",
            openrouter: "google/gemini-4-argon",
            price: tokens(4, 20, 0.2),
            promo: { price: tokens(2, 10, 0.1), until: "2026-12-01T00:00:00Z" },
          },
        ],
      },
      embedding: {
        defaultModel: "gemini-embedding-2",
        openModels: true,
        models: [
          {
            id: "gemini-embedding-2",
            note: "Takes gemini-embedding-2-preview's requests, in the same vector space",
            openrouter: "google/gemini-embedding-2",
            maxDim: 3072,
            price: tokens(0.2, 0),
          },
          { id: "gemini-embedding-001", maxDim: 3072, price: tokens(0.15, 0) },
        ],
      },
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    url: "https://platform.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    billingUrl: "https://platform.deepseek.com/top_up",
    credential: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    check: { path: "/models", auth: "bearer" },
    offers: {
      llm: {
        defaultModel: "deepseek-flash",
        openModels: true,
        modelsUrl: "https://api-docs.deepseek.com/quick_start/pricing",
        models: [
          {
            id: "deepseek-flash",
            note: "Half price off-peak; estimated at the peak price",
            openrouter: "~deepseek/deepseek-flash-latest",
            price: tokens(0.3, 1.2, 0.006),
          },
          {
            id: "deepseek-v4-pro",
            note: "Half price off-peak; estimated at the peak price",
            openrouter: "~deepseek/deepseek-pro-latest",
            price: tokens(1.32, 3.96, 0.044),
          },
        ],
      },
    },
  },
  {
    id: "xai",
    name: "xAI",
    url: "https://console.x.ai",
    keyUrl: "https://console.x.ai",
    billingUrl: "https://console.x.ai",
    credential: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    baseUrlEnv: "XAI_BASE_URL",
    check: { path: "/models", auth: "bearer" },
    offers: {
      llm: {
        defaultModel: "grok-4.20-non-reasoning",
        openModels: true,
        modelsUrl: "https://docs.x.ai/docs/models",
        models: [
          { id: "grok-4.20-non-reasoning", price: tokens(1.25, 2.5, 0.2) },
          {
            id: "grok-4.3",
            price: tokens(1.25, 2.5, 0.2),
            live: { reasoning_effort: "none" },
          },
          { id: "grok-4.7", openrouter: "x-ai/grok-4.7", price: tokens(2, 6, 0.5) },
        ],
      },
      realtime: {
        defaultModel: "grok-voice-latest",
        openModels: true,
        transport: "websocket",
        experimental: true,
        voices: {
          kind: "id",
          libraryUrl: "https://docs.x.ai/docs/guides/voice/agent",
          default: "eve",
        },
        models: [
          { id: "grok-voice-latest", price: { unit: "audio-hours", usd: 4.8 } },
          { id: "grok-voice-3.0", price: { unit: "audio-hours", usd: 4.8 } },
        ],
      },
    },
  },
  {
    id: "qwen",
    name: "Qwen (Alibaba Cloud Model Studio)",
    url: "https://modelstudio.console.alibabacloud.com",
    keyUrl: "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
    billingUrl: "https://usercenter2-intl.aliyun.com/billing",
    credential: "DASHSCOPE_API_KEY",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    check: { path: "/models", auth: "bearer" },
    offers: {
      llm: {
        defaultModel: "qwen-plus",
        openModels: true,
        modelsUrl: "https://www.alibabacloud.com/help/en/model-studio/models",
        models: [
          { id: "qwen-flash", price: tokens(0.05, 0.4, 0.01) },
          { id: "qwen-plus", price: tokens(0.4, 1.2, 0.08) },
          {
            id: "qwen3.8-flash",
            openrouter: "qwen/qwen3.8-flash",
            price: tokens(0.15, 0.47),
            live: { enable_thinking: false },
          },
          { id: "qwen-max", price: tokens(1.6, 6.4) },
        ],
      },
    },
  },
  {
    id: "moonshot",
    name: "Moonshot (Kimi)",
    url: "https://platform.moonshot.ai",
    keyUrl: "https://platform.moonshot.ai/console/api-keys",
    billingUrl: "https://platform.moonshot.ai/console/pay",
    credential: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.ai/v1",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    check: { path: "/models", auth: "bearer" },
    offers: {
      llm: {
        defaultModel: "kimi-k3.1-pro",
        openModels: true,
        modelsUrl: "https://platform.kimi.ai/docs/models",
        models: [
          {
            id: "kimi-k3.1-pro",
            note: "Always thinks; a live call asks for its lowest effort",
            openrouter: "moonshotai/kimi-k3.1-pro",
            price: tokens(2, 10, 0.2),
            live: { reasoning_effort: "low" },
          },
          { id: "kimi-k3", openrouter: "moonshotai/kimi-k3", price: tokens(3, 15, 0.3) },
        ],
      },
    },
  },
  {
    id: "zhipu",
    name: "Zhipu (GLM)",
    url: "https://z.ai",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    billingUrl: "https://z.ai/manage-apikey/billing",
    credential: "ZHIPU_API_KEY",
    baseUrl: "https://api.z.ai/api/paas/v4",
    baseUrlEnv: "ZHIPU_BASE_URL",
    check: { path: "/models", auth: "bearer" },
    offers: {
      llm: {
        defaultModel: "glm-5.3-flash",
        openModels: true,
        modelsUrl: "https://docs.z.ai/guides/overview/pricing",
        models: [
          {
            id: "glm-5.3-flash",
            note: "Always thinks",
            openrouter: "z-ai/glm-5.3-flash",
            price: tokens(0.15, 0.5, 0.03),
          },
          {
            id: "glm-5.3",
            note: "Always thinks",
            openrouter: "z-ai/glm-5.3",
            price: tokens(1.4, 4.4, 0.26),
          },
        ],
      },
    },
  },
  {
    id: "ollama",
    name: "Ollama",
    url: "https://ollama.com",
    keyUrl: null,
    billingUrl: null,
    credential: null,
    free: true,
    baseUrl: "http://localhost:11434/v1",
    baseUrlEnv: "OLLAMA_BASE_URL",
    offers: {
      llm: {
        defaultModel: "qwen3",
        openModels: true,
        modelsUrl: "https://ollama.com/library",
        models: [{ id: "qwen3" }, { id: "gemma3" }],
      },
    },
  },
  {
    id: "openai-compatible",
    name: "OpenAI-compatible endpoint",
    url: "https://platform.openai.com/docs/api-reference/chat",
    keyUrl: null,
    billingUrl: null,
    credential: "OPENAI_COMPATIBLE_API_KEY",
    keyOptional: true,
    baseUrl: null,
    baseUrlEnv: "OPENAI_COMPATIBLE_BASE_URL",
    check: { path: "/models", auth: "bearer" },
    offers: {
      llm: { defaultModel: null, openModels: true, models: [] },
      embedding: { defaultModel: null, openModels: true, models: [] },
    },
  },
  {
    id: "soniox",
    name: "Soniox",
    url: "https://soniox.com",
    keyUrl: "https://console.soniox.com/",
    billingUrl: "https://console.soniox.com/",
    credential: "SONIOX_API_KEY",
    baseUrl: "https://api.soniox.com/v1",
    baseUrlEnv: null,
    offers: {
      stt: {
        defaultModel: "stt-rt-v5",
        openModels: true,
        transport: "websocket",
        modelsUrl: "https://soniox.com/docs/stt/models",
        models: [
          {
            id: "stt-rt-v5",
            note: "Soniox removes it on 2026-12-15 and sends its requests to stt-rt-v6",
            price: { unit: "audio-hours", usd: 0.12 },
          },
          { id: "stt-rt-v6", price: { unit: "audio-hours", usd: 0.12 } },
        ],
      },
      tts: {
        defaultModel: "tts-rt-v2",
        openModels: true,
        transport: "websocket",
        voices: { kind: "id", libraryUrl: "https://soniox.com/docs/tts/voices" },
        models: [{ id: "tts-rt-v2" }],
      },
      transcription: {
        defaultModel: "stt-async-v5",
        openModels: true,
        modelsUrl: "https://soniox.com/docs/stt/models",
        models: [
          {
            id: "stt-async-v5",
            note: "Soniox removes it on 2026-12-15 and sends its requests to stt-async-v6",
            price: { unit: "audio-hours", usd: 0.1 },
          },
          { id: "stt-async-v6", price: { unit: "audio-hours", usd: 0.1 } },
        ],
      },
    },
  },
  {
    id: "fish",
    name: "Fish Audio",
    url: "https://fish.audio",
    keyUrl: "https://fish.audio/app/api-keys/",
    billingUrl: "https://fish.audio/app/developers/billing/",
    credential: "FISH_API_KEY",
    baseUrl: "https://api.fish.audio",
    baseUrlEnv: null,
    offers: {
      tts: {
        defaultModel: "drama-3",
        openModels: false,
        transport: "websocket",
        voices: { kind: "fish-library" },
        models: [
          {
            id: "drama-3",
            markup: "fish-drama",
            price: { unit: "bytes", usd: 50 },
            promo: { price: { unit: "bytes", usd: 10 }, until: "2026-12-01T08:00:00Z" },
          },
          { id: "s2.1-pro", markup: "brackets", price: { unit: "bytes", usd: 15 } },
          {
            id: "s2.1-pro-free",
            markup: "brackets",
            note: "Free under fair-use limits, without latency guarantees",
            price: { unit: "bytes", usd: 0 },
          },
          { id: "s2-pro", markup: "brackets", price: { unit: "bytes", usd: 15 } },
          {
            id: "s1",
            note: "Fish retires s1 on 2026-12-31 and serves its requests as s2.1-pro",
            price: { unit: "bytes", usd: 15 },
          },
        ],
      },
    },
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    url: "https://elevenlabs.io",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    billingUrl: "https://elevenlabs.io/app/subscription",
    credential: "ELEVENLABS_API_KEY",
    baseUrl: "https://api.elevenlabs.io",
    baseUrlEnv: null,
    check: { path: "/v1/user", auth: "xi-api-key" },
    offers: {
      stt: {
        defaultModel: "scribe_v2_realtime",
        openModels: true,
        transport: "websocket",
        models: [{ id: "scribe_v2_realtime", price: { unit: "audio-hours", usd: 0.39 } }],
      },
      tts: {
        defaultModel: "eleven_flash_v2_5",
        openModels: true,
        transport: "websocket",
        voices: { kind: "id", libraryUrl: "https://elevenlabs.io/app/voice-library" },
        models: [
          { id: "eleven_flash_v2_5", price: { unit: "characters", usd: 40 } },
          { id: "eleven_multilingual_v2", price: { unit: "characters", usd: 80 } },
          {
            id: "eleven_v3",
            markup: "brackets",
            price: { unit: "characters", usd: 80 },
          },
        ],
      },
    },
  },
  {
    id: "deepgram",
    name: "Deepgram",
    url: "https://deepgram.com",
    keyUrl: "https://console.deepgram.com/",
    billingUrl: "https://console.deepgram.com/",
    credential: "DEEPGRAM_API_KEY",
    baseUrl: "https://api.deepgram.com",
    baseUrlEnv: null,
    check: { path: "/v1/projects", auth: "token" },
    offers: {
      stt: {
        defaultModel: "nova-3-general",
        openModels: true,
        transport: "websocket",
        modelsUrl: "https://developers.deepgram.com/docs/models-languages-overview",
        models: [
          { id: "nova-3-general", price: { unit: "audio-hours", usd: 0.462 } },
          {
            id: "nova-2-general",
            note: "Nova 2 covers Chinese, where Nova 3 may not",
            price: { unit: "audio-hours", usd: 0.462 },
          },
        ],
      },
    },
  },
  {
    id: "cartesia",
    name: "Cartesia",
    url: "https://cartesia.ai",
    keyUrl: "https://play.cartesia.ai/keys",
    billingUrl: "https://play.cartesia.ai/subscription",
    credential: "CARTESIA_API_KEY",
    baseUrl: "https://api.cartesia.ai",
    baseUrlEnv: null,
    check: {
      path: "/voices?limit=1",
      auth: "x-api-key",
      headers: { "Cartesia-Version": "2025-04-16" },
    },
    offers: {
      tts: {
        defaultModel: "sonic-3.6",
        openModels: true,
        transport: "websocket",
        voices: { kind: "id", libraryUrl: "https://play.cartesia.ai/voices" },
        models: [{ id: "sonic-3.6", note: "Billed in credits by plan, so usage is unpriced" }],
      },
    },
  },
  {
    id: "minimax",
    name: "MiniMax",
    url: "https://www.minimax.io",
    keyUrl: "https://www.minimax.io/platform/user-center/basic-information/interface-key",
    billingUrl: "https://www.minimax.io/platform/user-center/payment/balance",
    credential: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io/v1",
    baseUrlEnv: "MINIMAX_BASE_URL",
    fields: [{ key: "groupId", env: "MINIMAX_GROUP_ID", label: "group id" }],
    offers: {
      tts: {
        defaultModel: "speech-2.8-turbo",
        openModels: true,
        transport: "http-stream",
        voices: {
          kind: "id",
          libraryUrl: "https://www.minimax.io/platform/document/system_voice_id",
        },
        models: [
          { id: "speech-2.8-turbo", price: { unit: "characters", usd: 60 } },
          { id: "speech-2.8-hd", price: { unit: "characters", usd: 100 } },
        ],
      },
    },
  },
  {
    id: "cohere",
    name: "Cohere",
    url: "https://cohere.com",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    billingUrl: "https://dashboard.cohere.com/billing",
    credential: "COHERE_API_KEY",
    baseUrl: "https://api.cohere.com/v2",
    baseUrlEnv: null,
    offers: {
      rerank: {
        defaultModel: "rerank-v4.0-fast",
        openModels: true,
        modelsUrl: "https://docs.cohere.com/docs/rerank",
        models: [
          { id: "rerank-v4.0-fast" },
          { id: "rerank-v4.0-pro" },
          { id: "rerank-v5.0-fast", price: tokens(0.02, 0) },
          { id: "rerank-v5.0-pro", price: tokens(0.05, 0) },
        ],
      },
    },
  },
];

const BY_ID: ReadonlyMap<string, Provider> = new Map(PROVIDERS.map((p) => [p.id, p]));

export function providerById(id: string): Provider | undefined {
  return BY_ID.get(id);
}

/** The providers that offer `category`, in catalog order. */
export function providersFor(category: Category): Provider[] {
  return PROVIDERS.filter((provider) => provider.offers[category] !== undefined);
}

/** The catalog's entry for `model`, if it lists one. */
export function modelInfo(
  providerId: string,
  category: Category,
  model: string,
): Model | undefined {
  return BY_ID.get(providerId)?.offers[category]?.models.find((entry) => entry.id === model);
}

/** A role a persona, or the whole install, fills with one provider's model. */
export const ROLE_IDS = [
  "hearing",
  "mind",
  "voice",
  "realtime",
  "gate",
  "rerank",
  "memory",
  "selfie",
  "transcription",
  "refine",
  "embeddings",
] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export interface Role {
  readonly id: RoleId;
  /** What it does, in English, for messages: "embeddings", "the retrieval gate". */
  readonly label: string;
  readonly category: Category;
  readonly scope: "persona" | "app";
  /** The settings path holding `provider` and `model`. */
  readonly path: string;
  readonly providerEnv: string;
  readonly modelEnv: string;
  /** null: the role is off unless a provider is named, as realtime is. */
  readonly defaultProvider: ProviderId | null;
  /** Where a role wants another model than its provider's default, by provider. */
  readonly defaultModels?: Readonly<Partial<Record<ProviderId, string>>>;
  /** Unset, the provider and model follow this role's. */
  readonly follows?: RoleId;
  /** A provider-named variable that also sets the model, read only while that provider fills it. */
  readonly legacyModelEnv?: { readonly env: string; readonly provider: ProviderId };
  /** A key for this role alone, ahead of the provider's. */
  readonly keyEnv?: string;
  /** An API base for this role alone, ahead of the provider's. */
  readonly baseUrlEnv?: string;
  /** When it spends: during a call, building an index, or never during a call. */
  readonly phase: "call" | "index" | "offline";
}

export const ROLES: readonly Role[] = [
  {
    id: "hearing",
    label: "speech recognition",
    category: "stt",
    scope: "persona",
    path: "hearing",
    providerEnv: "STT_PROVIDER",
    modelEnv: "STT_MODEL",
    defaultProvider: "soniox",
    legacyModelEnv: { env: "SONIOX_MODEL", provider: "soniox" },
    phase: "call",
  },
  {
    id: "mind",
    label: "chat",
    category: "llm",
    scope: "persona",
    path: "mind",
    providerEnv: "LLM_PROVIDER",
    modelEnv: "LLM_MODEL",
    defaultProvider: "openrouter",
    legacyModelEnv: { env: "OPENROUTER_MODEL", provider: "openrouter" },
    phase: "call",
  },
  {
    id: "voice",
    label: "speech",
    category: "tts",
    scope: "persona",
    path: "voice",
    providerEnv: "TTS_PROVIDER",
    modelEnv: "TTS_MODEL",
    defaultProvider: "fish",
    legacyModelEnv: { env: "FISH_MODEL", provider: "fish" },
    phase: "call",
  },
  {
    id: "realtime",
    label: "the realtime voice",
    category: "realtime",
    scope: "persona",
    path: "realtime",
    providerEnv: "REALTIME_PROVIDER",
    modelEnv: "REALTIME_MODEL",
    defaultProvider: null,
    phase: "call",
  },
  {
    id: "gate",
    label: "the retrieval gate",
    category: "decision",
    scope: "persona",
    path: "knowledge.gate",
    providerEnv: "RETRIEVAL_GATE_PROVIDER",
    modelEnv: "RETRIEVAL_GATE_MODEL",
    defaultProvider: "openrouter",
    phase: "call",
  },
  {
    id: "rerank",
    label: "reranking",
    category: "rerank",
    scope: "persona",
    path: "knowledge.rerank",
    providerEnv: "RERANK_PROVIDER",
    modelEnv: "RERANK_MODEL",
    defaultProvider: "openrouter",
    keyEnv: "RERANK_API_KEY",
    baseUrlEnv: "RERANK_BASE_URL",
    phase: "call",
  },
  {
    id: "memory",
    label: "memory extraction",
    category: "llm",
    scope: "persona",
    path: "memory",
    providerEnv: "MEM0_LLM_PROVIDER",
    modelEnv: "MEM0_LLM_MODEL",
    defaultProvider: "openrouter",
    follows: "mind",
    phase: "call",
  },
  {
    id: "selfie",
    label: "selfies",
    category: "image",
    scope: "persona",
    path: "selfie",
    providerEnv: "SELFIE_PROVIDER",
    modelEnv: "SELFIE_MODEL",
    defaultProvider: "openrouter",
    phase: "call",
  },
  {
    id: "transcription",
    label: "transcription",
    category: "transcription",
    scope: "persona",
    path: "transcription",
    providerEnv: "TRANSCRIBE_PROVIDER",
    modelEnv: "TRANSCRIBE_MODEL",
    defaultProvider: "soniox",
    legacyModelEnv: { env: "SONIOX_ASYNC_MODEL", provider: "soniox" },
    phase: "offline",
  },
  {
    id: "refine",
    label: "refinement",
    category: "llm",
    scope: "persona",
    path: "refine",
    providerEnv: "REFINE_PROVIDER",
    modelEnv: "REFINE_MODEL",
    defaultProvider: "openrouter",
    defaultModels: { openrouter: "~google/gemini-pro-latest" },
    keyEnv: "REFINE_API_KEY",
    baseUrlEnv: "REFINE_BASE_URL",
    phase: "offline",
  },
  {
    id: "embeddings",
    label: "embeddings",
    category: "embedding",
    scope: "app",
    path: "embeddings",
    providerEnv: "EMBED_PROVIDER",
    modelEnv: "EMBED_MODEL",
    defaultProvider: "openrouter",
    keyEnv: "EMBED_API_KEY",
    baseUrlEnv: "EMBED_BASE_URL",
    phase: "index",
  },
];

const ROLE_BY_ID: ReadonlyMap<string, Role> = new Map(ROLES.map((role) => [role.id, role]));

export function roleById(id: RoleId): Role {
  return ROLE_BY_ID.get(id) as Role;
}

/** The model `role` gets from a provider while none is named; null when it needs one named. */
export function defaultModel(role: Role, providerId: string): string | null {
  const offer = BY_ID.get(providerId)?.offers[role.category];
  if (offer === undefined) return null;
  return role.defaultModels?.[providerId as ProviderId] ?? offer.defaultModel;
}

/** The voice an offer speaks in while none is named; Fish's library has no default. */
export function defaultVoice(offer: Offer | undefined): string | undefined {
  const voices = offer?.voices;
  return voices !== undefined && voices.kind !== "fish-library" ? voices.default : undefined;
}

/** The variable naming the voice, and the prefix of a style's: `TTS_VOICE_ID_GENTLE`. */
export const VOICE_ENV = "TTS_VOICE_ID";
export const VOICE_STYLE_PREFIX = "TTS_VOICE_ID_";
/** Fish's names for the same, which apply while Fish speaks. */
export const LEGACY_VOICE_ENV = "FISH_VOICE_ID";
export const LEGACY_VOICE_STYLE_PREFIX = "FISH_VOICE_ID_";
/** The realtime model's voice. */
export const REALTIME_VOICE_ENV = "REALTIME_VOICE";

/** The roles a call runs, which a realtime model narrows to itself and the knowledge roles. */
export const CALL_ROLES: readonly RoleId[] = ["hearing", "mind", "voice"];
