import { SETTINGS } from "@eidolon/config";
import { describe, expect, test } from "vitest";
import type { AccountView, SettingRow } from "../../lib/api";
import { roleById, SETUP_ROLES } from "../../lib/providers";
import {
  activeRiders,
  callNeeds,
  choicesFor,
  envLock,
  keyNeeds,
  missingFields,
  modelAfter,
  pickChanges,
  RIDERS,
} from "./choices";

/** Every SETTINGS row as a home with no file and no environment shows it, `values` set by path. */
function rows(values: Readonly<Record<string, Partial<SettingRow>>> = {}): SettingRow[] {
  return SETTINGS.map((field) => ({
    ...field,
    value: null,
    source: "default",
    envValue: null,
    envName: null,
    envOverride: false,
    productionOnly: false,
    readOnly: false,
    ...values[field.path],
  }));
}

const hers = (value: string): Partial<SettingRow> => ({ value, source: "persona" });

function account(id: string, provider: string, extra: Partial<AccountView> = {}): AccountView {
  return {
    id,
    provider,
    name: id,
    isDefault: id === provider,
    saved: false,
    key: { value: null, source: null },
    baseUrl: { value: null, source: null },
    options: {},
    uses: [],
    needed: false,
    ...extra,
  };
}

const keyed = { key: { value: null, source: "account" as const } };

describe("choices", () => {
  test("every provider that offers a role, the recommended one first", () => {
    const names = (role: Parameters<typeof roleById>[0]) =>
      choicesFor(roleById(role), [], null).map((choice) => choice.account);
    expect(names("hearing")).toEqual([
      "soniox",
      "openai",
      "openai-compatible",
      "elevenlabs",
      "deepgram",
      "none",
    ]);
    expect(names("voice")).toEqual([
      "fish",
      "openai",
      "openai-compatible",
      "soniox",
      "fish-speech",
      "elevenlabs",
      "cartesia",
      "minimax",
      "none",
    ]);
    expect(names("embeddings")).toEqual(["openrouter", "openai", "google", "openai-compatible"]);
    // Only OpenRouter serves decision models today; a provider that adds them lists here.
    expect(names("gate")).toEqual(["openrouter"]);
    expect(names("mind")).toEqual([
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
    ]);
    expect(choicesFor(roleById("mind"), [], null).filter((choice) => choice.recommended)).toEqual([
      { account: "openrouter", name: "OpenRouter", recommended: true },
    ]);
  });

  test("the accounts Settings has join their provider's, and the current one is never lost", () => {
    const accounts = [
      account("openai-2", "openai", { name: "OpenAI (work)" }),
      account("openai-compatible", "openai-compatible", { name: "LM Studio" }),
    ];
    const listed = choicesFor(roleById("mind"), accounts, "gone").map((choice) => choice.name);
    expect(listed.slice(0, 3)).toEqual(["OpenRouter", "OpenAI", "OpenAI (work)"]);
    expect(listed.slice(-2)).toEqual(["LM Studio", "gone"]);
  });
});

describe("the model a pick runs", () => {
  const mind = roleById("mind");
  test("hers while the provider stays, the new provider's default once it moves", () => {
    const set = rows({ "mind.model": hers("~anthropic/claude-sonnet-latest") });
    expect(modelAfter(mind, set, {}, [])).toBe("~anthropic/claude-sonnet-latest");
    expect(modelAfter(mind, set, { "mind.provider": "openai" }, [])).toBe("gpt-6-luna");
    expect(modelAfter(mind, set, { "mind.provider": "openrouter" }, [])).toBe(
      "~anthropic/claude-sonnet-latest",
    );
  });

  test("the environment holds a pick with its provider, or a model any provider would get", () => {
    const embeddings = roleById("embeddings");
    expect(envLock(embeddings, rows())).toBeUndefined();
    const model = { envValue: "google/gemini-embedding-2-preview", envOverride: true };
    expect(envLock(embeddings, rows({ "embeddings.model": model }))?.env).toBe("EMBED_MODEL");
    const provider = { envValue: "google", envOverride: true };
    expect(envLock(embeddings, rows({ "embeddings.provider": provider }))?.env).toBe(
      "EMBED_PROVIDER",
    );
  });

  test("one typed wins, and an endpoint of your own has none until one is", () => {
    const own = [account("lab", "openai-compatible")];
    expect(modelAfter(mind, rows(), { "mind.provider": "lab" }, own)).toBeNull();
    expect(modelAfter(mind, rows(), { "mind.provider": "lab", "mind.model": " qwen3 " }, own)).toBe(
      "qwen3",
    );
  });
});

describe("what a save writes", () => {
  test("a changed pick, with the model and voice the old provider owned cleared", () => {
    const set = rows({
      "hearing.model": hers("stt-rt-v5"),
      "voice.voiceId": hers("0123456789abcdef0123456789abcdef"),
      "mind.model": hers("~google/gemini-flash-latest"),
    });
    const drafts = {
      "hearing.provider": "deepgram",
      "voice.provider": "openai",
      "mind.provider": "openrouter",
    };
    expect(pickChanges(set, drafts, [])).toEqual({
      persona: {
        "hearing.provider": "deepgram",
        "hearing.model": null,
        "voice.provider": "openai",
        "voice.voiceId": null,
      },
      app: {},
    });
  });

  test("embeddings go in settings.yaml, unless the environment sets them", () => {
    const set = rows({
      "embeddings.model": { value: "google/gemini-embedding-2-preview", source: "app" },
    });
    expect(pickChanges(set, { "embeddings.provider": "openai" }, [])).toEqual({
      persona: {},
      app: { "embeddings.provider": "openai", "embeddings.model": null },
    });
    const locked = rows({ "embeddings.provider": { envValue: "google", envOverride: true } });
    expect(pickChanges(locked, { "embeddings.provider": "openai" }, [])).toEqual({
      persona: {},
      app: {},
    });
  });

  test("a model typed for an endpoint of your own", () => {
    const own = [account("lab", "openai-compatible")];
    const drafts = { "mind.provider": "lab", "mind.model": " qwen3 " };
    expect(pickChanges(rows(), drafts, own).persona).toEqual({
      "mind.provider": "lab",
      "mind.model": "qwen3",
    });
  });
});

describe("the keys the picks need", () => {
  test("one key fills every role its account does, and a call's role makes it required", () => {
    const needs = keyNeeds(
      [
        { role: "hearing", account: "openai", call: true },
        { role: "mind", account: "openai", call: true },
        { role: "voice", account: "openai", call: true },
        { role: "embeddings", account: "openai", call: false },
      ],
      [account("openai", "openai", keyed)],
    );
    expect(needs).toEqual([
      {
        account: "openai",
        name: "openai",
        provider: "openai",
        roles: ["hearing", "mind", "voice", "embeddings"],
        key: "required",
        tier: "required",
        set: true,
      },
    ]);
  });

  test("hearing and voice make an account recommended: only a call waits for its key", () => {
    const needs = keyNeeds(
      [
        { role: "mind", account: "openrouter", call: true },
        { role: "hearing", account: "soniox", call: true },
        { role: "voice", account: "openai", call: true },
        { role: "embeddings", account: "openai", call: false },
        { role: "hearing", account: "lab", call: true },
      ],
      [account("lab", "openai-compatible")],
    );
    expect(needs.map(({ account, roles, tier }) => ({ account, roles, tier }))).toEqual([
      { account: "openrouter", roles: ["mind"], tier: "required" },
      { account: "soniox", roles: ["hearing"], tier: "recommended" },
      { account: "openai", roles: ["voice", "embeddings"], tier: "recommended" },
      // A server of your own may take no key, so none is recommended for it.
      { account: "lab", roles: ["hearing"], tier: "optional" },
    ]);
  });

  test("a realtime model's account is waited for, as the three it stands in for", () => {
    const [need] = keyNeeds([{ role: "realtime", account: "xai", call: true }], []);
    expect(need?.tier).toBe("required");
  });

  test("embeddings alone are optional; a server of your own asks for no key, Ollama none", () => {
    const needs = keyNeeds(
      [
        { role: "mind", account: "ollama", call: true },
        { role: "voice", account: "lab", call: true },
        { role: "hearing", account: "nobody", call: true },
        { role: "embeddings", account: "google", call: false },
      ],
      [account("lab", "openai-compatible")],
    );
    expect(
      needs.map(({ account, name, key, tier, set }) => ({ account, name, key, tier, set })),
    ).toEqual([
      { account: "ollama", name: "Ollama", key: "none", tier: "optional", set: true },
      { account: "lab", name: "lab", key: "optional", tier: "optional", set: false },
      { account: "google", name: "Google Gemini", key: "required", tier: "optional", set: false },
    ]);
  });

  test("an account only optional roles use is optional, whatever roles it fills", () => {
    const needs = keyNeeds(
      [
        { role: "mind", account: "anthropic", call: true },
        { role: "gate", account: "openrouter", call: false },
        { role: "rerank", account: "openrouter", call: false },
        { role: "selfie", account: "openrouter", call: false },
      ],
      [],
    );
    expect(needs.map(({ account, roles, tier }) => ({ account, roles, tier }))).toEqual([
      { account: "anthropic", roles: ["mind"], tier: "required" },
      { account: "openrouter", roles: ["gate", "rerank", "selfie"], tier: "optional" },
    ]);
  });

  test("a call's role makes an account required, whichever role named it first", () => {
    const needs = keyNeeds(
      [
        { role: "embeddings", account: "openrouter", call: false },
        { role: "mind", account: "openrouter", call: true },
      ],
      [],
    );
    expect(needs.map(({ roles, tier }) => ({ roles, tier }))).toEqual([
      { roles: ["embeddings", "mind"], tier: "required" },
    ]);
  });

  test("the picks put a call's roles first, and every role but those is optional", () => {
    expect(SETUP_ROLES.filter(callNeeds)).toEqual(["hearing", "mind", "voice"]);
    expect([...SETUP_ROLES, ...RIDERS].filter((role) => !callNeeds(role))).toEqual([
      "embeddings",
      "gate",
      "rerank",
      "selfie",
      "assistant",
      "search",
    ]);
  });

  test("activeRiders drops rerank or assistant roles when switched off, and selfies without outfits", () => {
    expect(activeRiders(rows(), 0)).toEqual(["rerank", "assistant", "search"]);
    expect(activeRiders(rows(), 2)).toEqual(["rerank", "selfie", "assistant", "search"]);
    expect(
      activeRiders(rows({ "knowledge.rerank.enabled": { value: false, source: "persona" } }), 1),
    ).toEqual(["selfie", "assistant", "search"]);
    expect(activeRiders(rows({ "assistant.enabled": { value: false, source: "app" } }), 1)).toEqual(
      ["rerank", "selfie"],
    );
  });

  test("MiniMax's group id, unless it is set or typed", () => {
    const need = { account: "minimax", provider: "minimax" };
    expect(missingFields(need, [], undefined)).toEqual(["groupId"]);
    expect(missingFields(need, [], { groupId: " 42 " })).toEqual([]);
    const saved = account("minimax", "minimax", {
      options: { groupId: { value: "42", source: "env" } },
    });
    expect(missingFields(need, [saved], undefined)).toEqual([]);
    expect(missingFields({ account: "openai", provider: "openai" }, [], undefined)).toEqual([]);
  });

  test("an OpenAI-compatible account requires an API base, while sttProtocol is optional", () => {
    const need = { account: "openai-compatible", provider: "openai-compatible" };
    expect(missingFields(need, [], undefined, "")).toEqual(["baseUrl"]);
    expect(missingFields(need, [], undefined, " http://127.0.0.1:8000/v1 ")).toEqual([]);
    const saved = account("openai-compatible", "openai-compatible", {
      baseUrl: { value: "http://127.0.0.1:8000/v1", source: "account" },
    });
    expect(missingFields(need, [saved], undefined)).toEqual([]);
    expect(missingFields(need, [saved], undefined, "")).toEqual(["baseUrl"]);
    expect(
      missingFields({ account: "fish-speech", provider: "fish-speech" }, [], undefined),
    ).toEqual([]);
  });

  test("clearing a saved model draft in KeysStep writes null so provider default applies", () => {
    const base = rows({
      "voice.provider": { value: "openai-compatible", source: "persona" },
      "voice.model": { value: "kokoro", source: "persona" },
    });
    expect(modelAfter(roleById("voice"), base, { "voice.model": "" }, [])).toBe("tts-1");
    expect(pickChanges(base, { "voice.model": "" }, [])).toEqual({
      persona: { "voice.model": null },
      app: {},
    });
  });
});
