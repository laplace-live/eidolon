import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PERSONA, IDENTITY_DEFAULTS, PROJECT_ROOT } from "@eidolon/config";
import { LOCAL_ROUTES } from "../../../../bot/src/local/api.ts";
import type { CredentialsResponse, SettingRow } from "../../lib/api";
import {
  cookieDefault,
  createRequest,
  DEFAULT_FANS,
  DEMO_PERSONA,
  EMPTY_PERSONA,
  firstStep,
  inheritedValue,
  isNewInstall,
  memoryStepAction,
  nextStep,
  PERSONA_ID,
  personaErrors,
  previousStep,
  QDRANT_COMMAND,
  QDRANT_IMAGE,
  RESERVED_IDS,
  STEPS,
  savedQdrant,
  suggestPersonaId,
} from "./wizard";

const keys = (fish: boolean) => ({
  keys: { SONIOX_API_KEY: true, OPENROUTER_API_KEY: true, FISH_API_KEY: fish },
});

describe("steps", () => {
  test("the wizard opens at the keys while one is missing, whatever the link asks", () => {
    expect(firstStep(keys(false), "memory")).toBe("keys");
    expect(firstStep(keys(true), "memory")).toBe("memory");
    expect(firstStep(keys(true), "nonsense")).toBe("keys");
    expect(firstStep(keys(true), null)).toBe("keys");
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
    envOverride: false,
    productionOnly: false,
    readOnly: false,
    ...extra,
  };
}

const none: CredentialsResponse = { SONIOX_API_KEY: { set: false, source: null } };
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
    const fromEnv = [...fresh, setting("memory.qdrant.host", { envOverride: true })];
    const withKey: CredentialsResponse = { SONIOX_API_KEY: { set: true, source: "env" } };
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

describe("the Qdrant one-liner", () => {
  test("pins the image docker-compose.yml runs", () => {
    const compose = readFileSync(join(PROJECT_ROOT, "docker-compose.yml"), "utf8");
    expect(compose).toContain(`image: ${QDRANT_IMAGE}\n`);
  });

  test("publishes on loopback only, keeps a named volume and turns CORS off", () => {
    expect(QDRANT_COMMAND).toContain(" -p 127.0.0.1:6333:6333 ");
    expect(QDRANT_COMMAND).not.toMatch(/-p (?!127\.0\.0\.1:)/);
    expect(QDRANT_COMMAND).toContain(" -v eidolon-qdrant:/qdrant/storage ");
    expect(QDRANT_COMMAND).toContain(" -e QDRANT__SERVICE__ENABLE_CORS=false ");
    expect(QDRANT_COMMAND.endsWith(` ${QDRANT_IMAGE}`)).toBe(true);
  });
});

describe("the memory step", () => {
  const saved = { host: "127.0.0.1", port: 6333 };

  test("goes on while memory is on at the address shown", () => {
    expect(memoryStepAction({ on: true, fromEnv: false, saved, typed: { ...saved } })).toBe("next");
    expect(memoryStepAction({ on: false, fromEnv: false, saved, typed: saved })).toBe("check");
  });

  test("an address edited once memory is on can be checked and saved again", () => {
    for (const typed of [
      { host: "qdrant.local", port: 6333 },
      { host: "127.0.0.1", port: 6334 },
      null,
    ]) {
      expect([typed, memoryStepAction({ on: true, fromEnv: false, saved, typed })]).toEqual([
        typed,
        "check",
      ]);
    }
    // The fields can't change an address the environment sets.
    expect(
      memoryStepAction({ on: true, fromEnv: true, saved, typed: { host: "x", port: 1 } }),
    ).toBe("next");
  });

  test("the saved address is settings.yaml's, the port defaulting as memory's does", () => {
    expect(savedQdrant(" 127.0.0.1 ", null)).toEqual(saved);
    expect(savedQdrant("qdrant.local", 7000)).toEqual({ host: "qdrant.local", port: 7000 });
    expect(savedQdrant(null, 6333)).toBeNull();
    expect(savedQdrant("  ", 6333)).toBeNull();
  });
});
