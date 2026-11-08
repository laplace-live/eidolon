import { describe, expect, test } from "bun:test";
import type { AccountEntry } from "@eidolon/config";
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
    expect(select("hearing", read)?.model).toBe("stt-rt-v5");
    expect(select("voice", read)?.model).toBe("drama-3");
    expect(select("transcription", read)?.model).toBe("stt-async-v5");
    expect(select("gate", read)?.model).toBe("~typesafe/jev-latest");
    expect(select("rerank", read)?.model).toBe("cohere/rerank-4-fast");
    expect(select("embeddings", read)?.model).toBe("google/gemini-embedding-2-preview");
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
    expect(select("transcription", reader({ SONIOX_ASYNC_MODEL: "stt-async-v6" }))?.model).toBe(
      "stt-async-v6",
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
});
