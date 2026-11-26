import { DEFAULT_PERSONA, IDENTITY_DEFAULTS } from "@eidolon/config";
import { describe, expect, test } from "vitest";
import { LOCAL_ROUTES } from "../../../../bot/src/local/api.ts";
import type { SettingRow } from "../../lib/api";
import {
  cookieDefault,
  createRequest,
  DEFAULT_FANS,
  DEMO_PERSONA,
  EMPTY_PERSONA,
  firstStep,
  fishVoiceAccount,
  flagOn,
  inheritedValue,
  isNewInstall,
  memoryStepAction,
  nextStep,
  PERSONA_ID,
  personaErrors,
  pickedVoice,
  previousStep,
  RESERVED_IDS,
  STEPS,
  suggestPersonaId,
  voiceProvider,
} from "./wizard";

const keys = (openrouter: boolean, fish = true) => ({
  keys: [
    { account: "soniox", name: "Soniox", provider: "soniox", roles: ["hearing"], set: true },
    {
      account: "openrouter",
      name: "OpenRouter",
      provider: "openrouter",
      roles: ["mind"],
      set: openrouter,
    },
    { account: "fish", name: "Fish Audio", provider: "fish", roles: ["voice"], set: fish },
  ],
});

describe("steps", () => {
  test("the wizard opens at the keys while one the app waits for is missing, whatever the link asks", () => {
    expect(firstStep(keys(false), "memory")).toBe("keys");
    expect(firstStep(keys(true), "memory")).toBe("memory");
    expect(firstStep(keys(true), "nonsense")).toBe("keys");
    expect(firstStep(keys(true), null)).toBe("keys");
  });

  test("a missing voice key, which only calls need, opens the step the link asks for", () => {
    expect(firstStep(keys(true, false), "memory")).toBe("memory");
  });

  test("next and previous walk the order and stop at its ends", () => {
    expect(STEPS).toEqual(["keys", "persona", "voice", "memory", "done"]);
    expect(nextStep("keys")).toBe("persona");
    expect(nextStep("done")).toBe("done");
    expect(previousStep("voice")).toBe("persona");
    expect(previousStep("keys")).toBeNull();
  });

  test("the demo is the bot's default persona", () => {
    expect(DEMO_PERSONA).toBe(DEFAULT_PERSONA);
  });
});

function setting(path: string, extra: Partial<SettingRow> = {}): SettingRow {
  return {
    path,
    env: "X",
    scope: "app",
    kind: "string",
    title: path,
    value: null,
    source: "default",
    envValue: null,
    envName: null,
    envOverride: false,
    productionOnly: false,
    readOnly: false,
    ...extra,
  };
}

/** The accounts a fresh home lists: the ones her calls need, without a key. */
const none = [{ saved: false, key: { value: null, source: null } }];
const fresh = [
  setting("sources.cookiesFromBrowser"),
  setting("voice.voiceId", { scope: "persona", source: "persona", value: "x" }),
];

describe("the new-install cookie default", () => {
  test("a fresh install writes none", () => {
    expect(isNewInstall(fresh, none)).toBe(true);
    expect(cookieDefault(fresh, true)).toEqual({ "sources.cookiesFromBrowser": "none" });
  });

  test("any saved setting, environment value or key makes the install an existing one", () => {
    const saved = [...fresh, setting("local.viewerName", { source: "app", value: "Ann" })];
    const fromEnv = [...fresh, setting("memory.enabled", { envOverride: true })];
    const withKey = [{ saved: false, key: { value: null, source: "env" as const } }];
    expect(isNewInstall(saved, none)).toBe(false);
    expect(isNewInstall(fromEnv, none)).toBe(false);
    expect(isNewInstall(fresh, withKey)).toBe(false);
    expect(cookieDefault(fresh, false)).toBeNull();
  });

  test("never over a value a file or the environment already sets", () => {
    const set = [setting("sources.cookiesFromBrowser", { source: "app", value: "firefox" })];
    const env = [setting("sources.cookiesFromBrowser", { envOverride: true })];
    expect(cookieDefault(set, true)).toBeNull();
    expect(cookieDefault(env, true)).toBeNull();
    expect(cookieDefault([], true)).toBeNull();
  });
});

test("a persona inherits the environment's value only while her file leaves it unset", () => {
  const voice = (patch: Partial<SettingRow>) =>
    setting("voice.voiceId", { env: "FISH_VOICE_ID", scope: "persona", ...patch });
  expect(inheritedValue(voice({ envValue: "env-voice" }))).toBe("env-voice");
  expect(inheritedValue(voice({ envValue: "env-voice", value: "" }))).toBe("env-voice");
  expect(
    inheritedValue(voice({ envValue: "env-voice", value: "hers", source: "persona" })),
  ).toBeNull();
  expect(inheritedValue(voice({}))).toBeNull();
  expect(inheritedValue(undefined)).toBeNull();
});

const provider = (patch: Partial<SettingRow>) =>
  setting("voice.provider", { env: "TTS_PROVIDER", scope: "persona", ...patch });

test("the voice step offers the voices of the provider she speaks through", () => {
  const accounts = [{ id: "speech", provider: "openai" }];
  expect(voiceProvider([], undefined)).toBe("fish");
  expect(voiceProvider([provider({ value: "fish", source: "persona" })], [])).toBe("fish");
  expect(voiceProvider([provider({ value: "openai", source: "persona" })], [])).toBe("openai");
  expect(voiceProvider([provider({ value: "speech", source: "persona" })], accounts)).toBe(
    "openai",
  );
  expect(voiceProvider([provider({ envValue: "elevenlabs" })], [])).toBe("elevenlabs");
  // An account Eidolon doesn't know: the Fish library, as the server takes a new persona's voice.
  expect(voiceProvider([provider({ value: "nobody", source: "persona" })], [])).toBe("fish");
  // Until the accounts load, an account's provider is unknown, not Fish's.
  expect(voiceProvider([provider({ value: "speech", source: "persona" })], undefined)).toBeNull();
});

test("the picker lists the own voices of the Fish account she speaks through, and no other's", () => {
  const accounts = [
    { id: "fish-2", provider: "fish" },
    { id: "speech", provider: "openai" },
  ];
  expect(fishVoiceAccount([], undefined)).toBe("fish");
  expect(fishVoiceAccount([provider({ value: "fish-2", source: "persona" })], accounts)).toBe(
    "fish-2",
  );
  expect(fishVoiceAccount([provider({ envValue: "FISH-2" })], accounts)).toBe("fish-2");
  expect(fishVoiceAccount([provider({ value: "speech", source: "persona" })], accounts)).toBeNull();
  expect(fishVoiceAccount([provider({ value: "nobody", source: "persona" })], [])).toBeNull();
  // Until the accounts load, only a provider's own account is known to be one of its.
  expect(
    fishVoiceAccount([provider({ value: "fish-2", source: "persona" })], undefined),
  ).toBeNull();
});

test("a voice picked from one provider is dropped once she speaks through another", () => {
  const pick = { provider: "fish", voice: "fish-voice" };
  expect(pickedVoice(pick, "fish")).toBe("fish-voice");
  expect(pickedVoice(pick, "openai")).toBeNull();
  expect(pickedVoice(pick, null)).toBeNull();
  expect(pickedVoice(null, "fish")).toBeNull();
});

test("a flag reads an active env override first, else her value, else the environment's, else its default", () => {
  const flag = (patch: Partial<SettingRow>) =>
    setting("knowledge.rerank.enabled", { env: "RERANK_ENABLED", kind: "flag", ...patch });
  expect(flagOn(undefined, true)).toBe(true);
  expect(flagOn(flag({}), false)).toBe(false);
  expect(flagOn(flag({ value: false, source: "persona" }), true)).toBe(false);
  expect(flagOn(flag({ envValue: "off" }), true)).toBe(false);
  expect(flagOn(flag({ value: true, source: "persona", envValue: "0" }), false)).toBe(true);
  expect(
    flagOn(flag({ value: true, source: "app", envValue: "false", envOverride: true }), false),
  ).toBe(false);
  expect(
    flagOn(flag({ value: false, source: "app", envValue: "1", envOverride: true }), false),
  ).toBe(true);
});

describe("creating a persona", () => {
  test("an id is suggested from the name's ASCII, and made unique", () => {
    expect(suggestPersonaId("Milky Green", [])).toBe("milky-green");
    expect(suggestPersonaId("Milky Green", ["milky-green", "milky-green-2"])).toBe("milky-green-3");
    expect(suggestPersonaId("  Héloïse   d'Arc!  ", [])).toBe("heloise-d-arc");
    expect(suggestPersonaId("明前奶绿", [])).toBe("");
    const long = suggestPersonaId("a".repeat(80), ["a".repeat(64)]);
    expect(long).toBe(`${"a".repeat(62)}-2`);
    for (const id of ["milky-green", "heloise-d-arc", long]) expect(PERSONA_ID.test(id)).toBe(true);
  });

  test("the reserved ids are the API's literal path words, as the server derives them", () => {
    const words = LOCAL_ROUTES.flatMap((route) =>
      (route.split(" ")[1] as string).split("/"),
    ).filter((segment) => segment !== "" && !segment.startsWith(":"));
    expect([...RESERVED_IDS].sort()).toEqual([...new Set(words)].sort());
    expect(suggestPersonaId("Index", [])).toBe("index-2");
    const draft = { ...EMPTY_PERSONA, id: "status", name: "S", timezone: "UTC" };
    expect(personaErrors(draft, [])).toEqual({ id: "setup.persona.id.reserved" });
  });

  test("ids are lowercase slugs", () => {
    for (const bad of ["", "-x", "_x", "Ab", "a b", "a/b", "..", "a".repeat(65), "奶绿"]) {
      expect(PERSONA_ID.test(bad)).toBe(false);
    }
    expect(PERSONA_ID.test("a".repeat(64))).toBe(true);
  });

  test("a draft needs an unused id, a name and a real time zone", () => {
    const draft = { ...EMPTY_PERSONA, id: "mine", name: "Mine", timezone: "Asia/Tokyo" };
    expect(personaErrors(draft, [])).toEqual({});
    expect(personaErrors(draft, ["mine"])).toEqual({ id: "errors.persona-exists" });
    expect(personaErrors({ ...draft, id: "Mine", name: " ", timezone: "Mars/Base" }, [])).toEqual({
      id: "errors.invalid-persona-id",
      name: "setup.persona.required",
      timezone: "settings.form.invalid.timezone",
    });
  });

  test("blank short name and fans word get the bot's defaults", () => {
    expect(DEFAULT_FANS).toBe(IDENTITY_DEFAULTS.fans);
    const draft = { ...EMPTY_PERSONA, id: " mine ", name: " 小绿 ", timezone: "Asia/Shanghai" };
    expect(createRequest(draft, "v".repeat(32))).toEqual({
      id: "mine",
      name: "小绿",
      shortName: "小绿",
      fans: "观众",
      summary: "",
      timezone: "Asia/Shanghai",
      voiceId: "v".repeat(32),
    });
  });
});

describe("the memory step", () => {
  test("offers turning memory on until enabled or locked by the environment", () => {
    expect(memoryStepAction({ on: false, fromEnv: false })).toBe("turn-on");
    expect(memoryStepAction({ on: true, fromEnv: false })).toBe("next");
    expect(memoryStepAction({ on: false, fromEnv: true })).toBe("next");
    expect(memoryStepAction({ on: true, fromEnv: true })).toBe("next");
  });
});
