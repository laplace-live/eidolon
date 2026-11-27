import type { AccountEntry } from "@eidolon/config";
import { describe, expect, test } from "vitest";
import {
  accountOf,
  accountsFor,
  callRoles,
  hasKey,
  listAccounts,
  missingKey,
  ProviderConfigError,
  realtimeVoiceOf,
  type Sources,
  select,
  selectRequired,
  selectTask,
  voiceOf,
} from "../src/index.ts";

const reader =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | undefined =>
    values[name] || undefined;

describe("select", () => {
  test("defaults to the providers and models production ran before roles had providers", () => {
    const read = reader({ OPENROUTER_API_KEY: "or", SONIOX_API_KEY: "sx", FISH_API_KEY: "fk" });
    const mind = select("mind", read);
    expect(mind?.provider.id).toBe("openrouter");
    expect(mind?.model).toBe("~google/gemini-flash-latest");
    expect(mind?.apiKey).toBe("or");
    expect(mind?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(select("hearing", read)?.model).toBe("stt-rt-v6");
    expect(select("voice", read)?.model).toBe("drama-3");
    expect(select("transcription", read)?.model).toBe("stt-async-v6");
    expect(select("gate", read)?.model).toBe("~typesafe/jev-latest");
    expect(select("rerank", read)?.model).toBe("cohere/rerank-4-fast");
    expect(select("embeddings", read)?.model).toBe("google/gemini-embedding-2-preview");
    expect(select("assistant", read)?.model).toBe("~google/gemini-flash-latest");
    expect(select("assistant-quick", read)?.model).toBe("~google/gemini-flash-latest");
    expect(select("assistant-coding", read)?.model).toBe("~google/gemini-flash-latest");
    expect(select("assistant-research", read)?.model).toBe("~google/gemini-flash-latest");
    expect(select("search", read)?.model).toBe("exa");
    expect(select("realtime", read)).toBeNull();
  });

  test("reads a provider-named variable only while that provider fills the role", () => {
    expect(select("mind", reader({ OPENROUTER_MODEL: "x/y" }))?.model).toBe("x/y");
    expect(select("mind", reader({ LLM_MODEL: "a/b", OPENROUTER_MODEL: "x/y" }))?.model).toBe(
      "a/b",
    );
    const claude = select("mind", reader({ LLM_PROVIDER: "anthropic", OPENROUTER_MODEL: "x/y" }));
    expect(claude?.model).toBe("claude-opus-5-5");
    expect(claude?.keyName).toBe("ANTHROPIC_API_KEY");
    expect(select("voice", reader({ FISH_MODEL: "s2.1-pro" }))?.model).toBe("s2.1-pro");
    expect(
      select("voice", reader({ TTS_PROVIDER: "elevenlabs", FISH_MODEL: "s2.1-pro" }))?.model,
    ).toBe("eleven_flash_v2_5");
    expect(select("transcription", reader({ SONIOX_ASYNC_MODEL: "stt-async-v5" }))?.model).toBe(
      "stt-async-v5",
    );
  });

  test("memory follows the mind's provider and model until it names its own", () => {
    const same = select("memory", reader({ LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-pro" }));
    expect(same?.provider.id).toBe("deepseek");
    expect(same?.model).toBe("deepseek-pro");
    expect(select("memory", reader({ OPENROUTER_MODEL: "x/y" }))?.model).toBe("x/y");
    const own = select(
      "memory",
      reader({ LLM_PROVIDER: "deepseek", LLM_MODEL: "deepseek-pro", MEM0_LLM_PROVIDER: "openai" }),
    );
    expect(own?.provider.id).toBe("openai");
    expect(own?.model).toBe("gpt-6-luna");
    expect(select("memory", reader({ MEM0_LLM_MODEL: "m/n" }))?.model).toBe("m/n");
  });

  test("a role's own key and API base win over the provider's", () => {
    const read = reader({
      OPENROUTER_API_KEY: "or",
      EMBED_API_KEY: "ek",
      EMBED_BASE_URL: "https://api.openai.com/v1",
    });
    const embeddings = select("embeddings", read);
    expect(embeddings?.apiKey).toBe("ek");
    expect(embeddings?.keyName).toBe("EMBED_API_KEY");
    expect(embeddings?.baseUrl).toBe("https://api.openai.com/v1");
    const rerank = select("rerank", reader({ OPENROUTER_API_KEY: "or" }));
    expect(rerank?.keyName).toBe("OPENROUTER_API_KEY");
    expect(select("refine", reader({ OPENROUTER_API_BASE: "https://proxy/v1" }))?.baseUrl).toBe(
      "https://proxy/v1",
    );
  });

  test("names what is wrong: an unknown provider, one without the role's kind, a missing base", () => {
    expect(() => select("mind", reader({ LLM_PROVIDER: "nope" }))).toThrow(
      "LLM_PROVIDER=nope is no provider or account Eidolon knows",
    );
    expect(() => select("mind", reader({ LLM_PROVIDER: "fish" }))).toThrow(
      "Fish Audio offers no chat model (LLM_PROVIDER)",
    );
    expect(() => select("mind", reader({ LLM_PROVIDER: "openai-compatible" }))).toThrow(
      "needs a model: set LLM_MODEL",
    );
    expect(() =>
      select("mind", reader({ LLM_PROVIDER: "openai-compatible", LLM_MODEL: "m" })),
    ).toThrow("needs an API base: set OPENAI_COMPATIBLE_BASE_URL");
    expect(() => selectRequired("realtime", reader({}))).toThrow(ProviderConfigError);
  });

  test("is case- and space-insensitive about the provider, and blank is unset", () => {
    expect(select("mind", reader({ LLM_PROVIDER: " DeepSeek " }))?.provider.id).toBe("deepseek");
    expect(select("mind", reader({ LLM_PROVIDER: "  " }))?.provider.id).toBe("openrouter");
  });

  test("a provider that takes no key needs none", () => {
    const local = select("mind", reader({ LLM_PROVIDER: "ollama" }));
    expect(local?.keyName).toBeNull();
    expect(local?.baseUrl).toBe("http://localhost:11434/v1");
  });

  test("the assistant defaults to OpenRouter and its default model, independent of the chat model", () => {
    // Her chat model, either way it is set, is never the assistant's.
    const chat = { OPENROUTER_API_KEY: "or", LLM_MODEL: "a/b", OPENROUTER_MODEL: "c/d" };
    const fallback = select("assistant", reader(chat));
    expect([fallback?.provider.id, fallback?.model, fallback?.apiKey]).toEqual([
      "openrouter",
      "~google/gemini-flash-latest",
      "or",
    ]);
    for (const [provider, expected] of [
      ["openrouter", "~google/gemini-flash-latest"],
      ["anthropic", "claude-opus-5-5"],
      ["deepseek", "deepseek-flash"],
      ["openai", "gpt-6-luna"],
    ] as const) {
      expect(select("assistant", reader({ ...chat, ASSISTANT_PROVIDER: provider }))?.model).toBe(
        expected,
      );
    }
    expect(() =>
      select("assistant", reader({ ...chat, ASSISTANT_PROVIDER: "openai-compatible" })),
    ).toThrow("needs a model: set ASSISTANT_MODEL");
    const picked = select(
      "assistant",
      reader({ ...chat, ASSISTANT_PROVIDER: "openrouter", ASSISTANT_MODEL: "x/y" }),
    );
    expect([picked?.provider.id, picked?.model, picked?.apiKey]).toEqual([
      "openrouter",
      "x/y",
      "or",
    ]);
  });
});

describe("selectTask", () => {
  const assistant = {
    OPENROUTER_API_KEY: "or",
    ASSISTANT_PROVIDER: "openrouter",
    ASSISTANT_MODEL: "x/assistant",
  };
  /** A task of `kind`'s account, model and key, and why it fell back. */
  const task = (
    kind: Parameters<typeof selectTask>[0],
    values: Readonly<Record<string, string>>,
    accounts: readonly AccountEntry[] = [],
  ) => {
    const sources: Sources = {
      read: reader(values),
      env: reader(values),
      accounts: new Map(accounts.map((account) => [account.id, account])),
    };
    const { selection, fallback } = selectTask(kind, sources);
    return [selection.role.id, selection.account.id, selection.model, selection.apiKey, fallback];
  };

  test("a task of no kind, or of other, runs on the assistant role", () => {
    const expected = ["assistant", "openrouter", "x/assistant", "or", null];
    expect(task(undefined, assistant)).toEqual(expected);
    expect(task("other", assistant)).toEqual(expected);
    // Whatever a kind's own settings say.
    expect(task("other", { ...assistant, ASSISTANT_QUICK_MODEL: "x/quick" })).toEqual(expected);
  });

  test("a kind that names nothing runs on the assistant's account and model", () => {
    for (const kind of ["quick", "coding", "research"] as const) {
      expect(task(kind, assistant)).toEqual(["assistant", "openrouter", "x/assistant", "or", null]);
    }
  });

  test("a kind's model alone runs on the assistant's account", () => {
    expect(task("quick", { ...assistant, ASSISTANT_QUICK_MODEL: "x/quick" })).toEqual([
      "assistant-quick",
      "openrouter",
      "x/quick",
      "or",
      null,
    ]);
  });

  test("a kind's own account and model, whether or not the assistant's are set", () => {
    const coding = {
      ASSISTANT_CODING_PROVIDER: "anthropic",
      ASSISTANT_CODING_MODEL: "claude-sonnet-5-5",
      ANTHROPIC_API_KEY: "ak",
    };
    const expected = ["assistant-coding", "anthropic", "claude-sonnet-5-5", "ak", null];
    expect(task("coding", { ...assistant, ...coding })).toEqual(expected);
    expect(task("coding", coding)).toEqual(expected);
    // Another provider with no model named uses its own default model, not the assistant's.
    expect(
      task("coding", {
        ...assistant,
        ASSISTANT_CODING_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "ak",
      }),
    ).toEqual(["assistant-coding", "anthropic", "claude-opus-5-5", "ak", null]);
    // Another account of the assistant's provider takes the assistant's model.
    const work = {
      id: "openrouter-work",
      provider: "openrouter",
      name: null,
      apiKey: "or-work",
      baseUrl: null,
      options: {},
    };
    expect(
      task("research", { ...assistant, ASSISTANT_RESEARCH_PROVIDER: "openrouter-work" }, [work]),
    ).toEqual(["assistant-research", "openrouter-work", "x/assistant", "or-work", null]);
  });

  test("a kind whose own can't run falls back to the assistant's, saying why", () => {
    const fallback = (values: Readonly<Record<string, string>>) => {
      const [role, account, model, , why] = task("coding", { ...assistant, ...values });
      expect([role, account, model]).toEqual(["assistant", "openrouter", "x/assistant"]);
      return why;
    };
    expect(
      fallback({
        ASSISTANT_CODING_PROVIDER: "openai-compatible",
        OPENAI_COMPATIBLE_BASE_URL: "http://localhost:1234/v1",
      }),
    ).toBe("OpenAI-compatible endpoint needs a model: set ASSISTANT_CODING_MODEL");
    expect(
      fallback({
        ASSISTANT_CODING_PROVIDER: "anthropic",
        ASSISTANT_CODING_MODEL: "claude-sonnet-5-5",
      }),
    ).toBe(
      "Anthropic needs an API key: set ANTHROPIC_API_KEY in credentials.json or the environment",
    );
    expect(fallback({ ASSISTANT_CODING_PROVIDER: "ghost" })).toBe(
      "ASSISTANT_CODING_PROVIDER=ghost is no provider or account Eidolon knows",
    );
    expect(fallback({ ASSISTANT_CODING_PROVIDER: "fish" })).toBe(
      "Fish Audio offers no chat model (ASSISTANT_CODING_PROVIDER)",
    );
  });

  test("with the assistant role unset, OpenRouter and its default model fill it; an unusable assistant throws", () => {
    const keyOnly = { OPENROUTER_API_KEY: "or" };
    expect(task("other", keyOnly)).toEqual([
      "assistant",
      "openrouter",
      "~google/gemini-flash-latest",
      "or",
      null,
    ]);
    expect(task("quick", { ...keyOnly, ASSISTANT_QUICK_MODEL: "x/quick" })).toEqual([
      "assistant-quick",
      "openrouter",
      "x/quick",
      "or",
      null,
    ]);
    const badAssistant = { ASSISTANT_PROVIDER: "openai-compatible" };
    for (const values of [badAssistant, { ...badAssistant, ASSISTANT_QUICK_MODEL: "x/quick" }]) {
      expect(() => task("quick", values)).toThrow("OpenAI-compatible endpoint needs a model");
    }
    expect(() => task("other", badAssistant)).toThrow(ProviderConfigError);
  });
});

describe("voices", () => {
  test("TTS_VOICE_ID, Fish's own variable while Fish speaks, else the provider's default", () => {
    const fish = select("voice", reader({}));
    if (fish === null) throw new Error("no voice");
    expect(voiceOf(fish, reader({ FISH_VOICE_ID: "f1" }))).toBe("f1");
    expect(voiceOf(fish, reader({ TTS_VOICE_ID: "t1", FISH_VOICE_ID: "f1" }))).toBe("t1");
    expect(voiceOf(fish, reader({}))).toBeUndefined();
    const openai = select("voice", reader({ TTS_PROVIDER: "openai" }));
    if (openai === null) throw new Error("no voice");
    expect(voiceOf(openai, reader({ FISH_VOICE_ID: "f1" }))).toBe("marin");
  });

  test("a realtime model speaks REALTIME_VOICE, else its provider's default", () => {
    const read = reader({ REALTIME_PROVIDER: "openai" });
    const realtime = select("realtime", read);
    if (realtime === null) throw new Error("no realtime");
    expect(realtimeVoiceOf(realtime, read)).toBe("marin");
    expect(realtimeVoiceOf(realtime, reader({ REALTIME_VOICE: "cedar" }))).toBe("cedar");
  });
});

describe("a call's keys", () => {
  test("three models, or one realtime model", () => {
    expect(callRoles(reader({}))).toEqual(["hearing", "mind", "voice"]);
    expect(callRoles(reader({ REALTIME_PROVIDER: "xai" }))).toEqual(["realtime"]);
  });

  test("one entry per account, with every role it serves and whether its key is set", () => {
    const needs = accountsFor(
      ["hearing", "mind", "voice", "memory", "gate"],
      reader({ OPENROUTER_API_KEY: "or" }),
    );
    expect(needs.map(({ account, roles, set }) => ({ id: account.id, roles, set }))).toEqual([
      { id: "soniox", roles: ["hearing"], set: false },
      { id: "openrouter", roles: ["mind", "memory", "gate"], set: true },
      { id: "fish", roles: ["voice"], set: false },
    ]);
  });

  test("a role with a provider error is left to report its error", () => {
    expect(accountsFor(["mind"], reader({ LLM_PROVIDER: "nope" }))).toEqual([]);
  });
});

describe("accounts", () => {
  const entry = (
    id: string,
    fields: Partial<AccountEntry> & { provider: string },
  ): AccountEntry => ({
    id,
    name: null,
    apiKey: null,
    baseUrl: null,
    options: {},
    ...fields,
  });
  /** `env` the environment, `files` what the settings files add, `accounts` credentials.json's. */
  const sources = (
    env: Readonly<Record<string, string>>,
    files: Readonly<Record<string, string>> = {},
    accounts: readonly AccountEntry[] = [],
  ): Sources => ({
    read: (name) => env[name] || files[name] || undefined,
    env: (name) => env[name] || undefined,
    accounts: new Map(accounts.map((account) => [account.id, account])),
  });

  test("a role's own key and API base stay with its default provider's account", () => {
    const overrides = {
      OPENAI_API_KEY: "sk-own",
      EMBED_API_KEY: "ek",
      EMBED_BASE_URL: "https://embed.example/v1",
    };
    const other = select("embeddings", sources({ ...overrides, EMBED_PROVIDER: "openai" }));
    expect(other).toMatchObject({
      apiKey: "sk-own",
      keyName: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
    });
    const work = entry("openrouter-2", { provider: "openrouter", apiKey: "or-work" });
    const added = select(
      "embeddings",
      sources({ ...overrides, EMBED_PROVIDER: "openrouter-2" }, {}, [work]),
    );
    expect(added).toMatchObject({
      apiKey: "or-work",
      keyName: null,
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const keyless = select("embeddings", sources({ EMBED_PROVIDER: "openai" }));
    if (keyless === null) throw new Error("no embeddings");
    expect(missingKey(keyless).message).toBe(
      "OpenAI needs an API key: set OPENAI_API_KEY in credentials.json or the environment",
    );
  });

  test("a second account of a provider fills a role with its own key, base and settings", () => {
    const work = entry("openai-work", {
      provider: "openai",
      name: "OpenAI (work)",
      apiKey: "sk-work",
      baseUrl: "https://proxy.example/v1",
    });
    const mind = select(
      "mind",
      sources({ LLM_PROVIDER: "openai-work", OPENAI_API_KEY: "sk-own" }, {}, [work]),
    );
    expect(mind).toMatchObject({
      provider: { id: "openai" },
      account: { id: "openai-work", name: "OpenAI (work)", isDefault: false },
      apiKey: "sk-work",
      baseUrl: "https://proxy.example/v1",
      keyName: null,
      model: "gpt-6-luna",
    });
    const voice = select(
      "voice",
      sources({ TTS_PROVIDER: "minimax-cn" }, {}, [
        entry("minimax-cn", { provider: "minimax", options: { groupId: "g1" } }),
      ]),
    );
    expect(voice?.options).toEqual({ groupId: "g1" });
    expect(voice?.account.name).toBe("MiniMax (minimax-cn)");
    if (voice === null) throw new Error("no voice");
    expect(hasKey(voice)).toBe(false);
    expect(missingKey(voice).message).toBe(
      "The MiniMax (minimax-cn) account has no API key: add it in Settings → Providers",
    );
  });

  test("a provider's default account: the environment, then its entry, then the files", () => {
    const saved = entry("openai", {
      provider: "openai",
      apiKey: "sk-saved",
      baseUrl: "https://a/v1",
    });
    const read = (env: Record<string, string>, files: Record<string, string> = {}) =>
      accountOf("openai", sources(env, files, [saved]));
    expect(read({})).toMatchObject({
      apiKey: "sk-saved",
      keySource: "account",
      baseUrl: "https://a/v1",
    });
    expect(read({ OPENAI_API_KEY: "sk-env", OPENAI_BASE_URL: "https://e/v1" })).toMatchObject({
      apiKey: "sk-env",
      keySource: "env",
      baseUrl: "https://e/v1",
      baseSource: "env",
    });
    const flat = accountOf("openai", sources({}, { OPENAI_API_KEY: "sk-flat" }));
    expect(flat).toMatchObject({ apiKey: "sk-flat", keySource: "credentials", saved: false });
    expect(flat?.baseSource).toBe("default");
  });

  test("an id that is no account, and an entry under another provider's id, name none", () => {
    expect(() => select("mind", sources({ LLM_PROVIDER: "ghost" }))).toThrow(
      "LLM_PROVIDER=ghost is no provider or account Eidolon knows",
    );
    expect(
      accountOf("openai", sources({}, {}, [entry("openai", { provider: "anthropic" })])),
    ).toBeUndefined();
  });

  test("the accounts to pick from: credentials.json's, and each default its variables configure", () => {
    const listed = listAccounts(
      sources({ SONIOX_API_KEY: "sx" }, { OPENROUTER_API_KEY: "or" }, [
        entry("deepseek-2", { provider: "deepseek", apiKey: "d2" }),
        entry("openai-work", { provider: "openai", apiKey: "w" }),
      ]),
    );
    expect(listed.map((account) => account.id)).toEqual([
      "openrouter",
      "openai-work",
      "deepseek-2",
      "soniox",
    ]);
  });

  test("none explicitly turns off optional hearing and voice roles without breaking required ones", () => {
    expect(select("hearing", sources({ STT_PROVIDER: "none" }))).toBeNull();
    expect(select("voice", sources({ TTS_PROVIDER: "NONE" }))).toBeNull();
    expect(() => selectRequired("voice", sources({ TTS_PROVIDER: "none" }))).toThrow(
      "speech is turned off (TTS_PROVIDER=none)",
    );
    expect(() => select("mind", sources({ LLM_PROVIDER: "none" }))).toThrow(
      "LLM_PROVIDER=none is no provider or account Eidolon knows",
    );
  });
});
