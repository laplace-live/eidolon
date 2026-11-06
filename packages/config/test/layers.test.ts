import "./isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREDENTIALS,
  dataHome,
  envOptional,
  envOverride,
  installSettings,
  type LayeredSetting,
  loadSettings,
  logger,
  PROJECT_ROOT,
  readSettingsLayers,
  resetSettings,
  SETTINGS,
  setSettingDefaults,
} from "../src/index.ts";

const touched = new Set<string>();
function setEnv(name: string, value: string | undefined): void {
  touched.add(name);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const warnings: string[] = [];
const removeSink = logger.addSink((record) => {
  if (record.level === "WARNING") warnings.push(record.message);
});
process.on("exit", removeSink);

afterEach(() => {
  for (const name of touched) delete process.env[name];
  touched.clear();
  warnings.length = 0;
  setSettingDefaults(null);
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

function write(rel: string, text: string): string {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const TEMPLATE = join(PROJECT_ROOT, "personas", "milky-green");
const UNSET: LayeredSetting = { source: "default", value: null, raw: null };

function setValues(values: ReadonlyMap<string, LayeredSetting>): [string, string][] {
  return [...values].flatMap(([env, layer]) =>
    layer.value === null ? [] : [[env, layer.value] as [string, string]],
  );
}

describe("loadSettings", () => {
  test("is unchanged on the templates", () => {
    const loaded = loadSettings();
    expect(loaded.persona.id).toBe("milky-green");
    expect(loaded.persona.identity.name).toBe("明前奶绿");
    expect([...loaded.values]).toEqual([
      ["PERSONA_TIMEZONE", "Asia/Shanghai"],
      ["FACTS_FILES", "*设定集.txt,*事件集.txt"],
      ["FACTS_SUBJECT", "明前奶[绿黑]"],
    ]);
    expect(loaded.files).toEqual({
      home: dataHome(),
      settings: join(dataHome(), "settings.yaml"),
      credentials: join(dataHome(), "credentials.json"),
      persona: join(TEMPLATE, "persona.yaml"),
    });
    expect(warnings).toEqual([]);
  });

  test("holds exactly the values readSettingsLayers sets, in its order", () => {
    write("settings.yaml", "local:\n  viewerName: 小明\nembeddings:\n  dim: 768\n");
    write(
      "personas/milky-green/persona.yaml",
      "voice:\n  voiceId: base\n  styles:\n    gentle: soft\nmemory:\n  agentId: shop\n",
    );
    chmodSync(write("credentials.json", '{"FISH_API_KEY": "fk", "SONIOX_API_KEY": "sk"}'), 0o600);
    const layers = readSettingsLayers("milky-green");
    expect([...loadSettings().values]).toEqual(setValues(layers.values));
    expect(setValues(layers.values)).toEqual([
      ["EIDOLON_LOCAL_VIEWER_NAME", "小明"],
      ["EMBED_DIM", "768"],
      ["FISH_VOICE_ID", "base"],
      ["MEM0_AGENT_ID", "shop"],
      ["FISH_VOICE_ID_GENTLE", "soft"],
      ["FISH_API_KEY", "fk"],
      ["SONIOX_API_KEY", "sk"],
    ]);
  });
});

describe("readSettingsLayers", () => {
  test("reports every setting and credential, default and null where nothing sets it", () => {
    const layers = readSettingsLayers("milky-green");
    expect(layers.persona).toBe("milky-green");
    expect(layers.values.get("PERSONA_TIMEZONE")).toEqual({
      source: "persona",
      value: "Asia/Shanghai",
      raw: "Asia/Shanghai",
    });
    expect(layers.values.get("FACTS_FILES")).toEqual({
      source: "persona",
      value: "*设定集.txt,*事件集.txt",
      raw: ["*设定集.txt", "*事件集.txt"],
    });
    expect(layers.values.get("MEM0_QDRANT_HOST")).toEqual(UNSET);
    for (const setting of SETTINGS) expect(layers.values.has(setting.env)).toBe(true);
    for (const name of CREDENTIALS) expect(layers.values.get(name)).toEqual(UNSET);
    expect(layers.warnings).toEqual([]);
  });

  test("keeps a path as the file wrote it beside the path the bot reads", () => {
    write("personas/milky-green/persona.yaml", "prompt: prompt.md\n");
    expect(readSettingsLayers("milky-green").values.get("PERSONA_FILE")).toEqual({
      source: "persona",
      value: join(TEMPLATE, "prompt.md"),
      raw: "prompt.md",
    });
  });

  test("reads the persona it is given, not the active one", () => {
    write("personas/other/persona.yaml", "mind:\n  model: other/model\n");
    const other = readSettingsLayers("other");
    expect(other.files.persona).toBe(join(dataHome(), "personas", "other", "persona.yaml"));
    expect(other.values.get("OPENROUTER_MODEL")?.value).toBe("other/model");
    expect(readSettingsLayers("milky-green").values.get("OPENROUTER_MODEL")).toEqual(UNSET);
  });

  test("a wrong kind keeps its layer and raw value, with no value, and warns only in the result", () => {
    const path = write("settings.yaml", "embeddings:\n  dim: [1]\nbogus: 1\n");
    chmodSync(write("credentials.json", '{"FISH_API_KEY": 7, "OPENROUTER_API_KEY": ""}'), 0o600);
    const layers = readSettingsLayers("milky-green");
    expect(layers.values.get("EMBED_DIM")).toEqual({ source: "app", value: null, raw: [1] });
    expect(layers.values.get("FISH_API_KEY")).toEqual({
      source: "credentials",
      value: null,
      raw: 7,
    });
    expect(layers.values.get("OPENROUTER_API_KEY")).toEqual(UNSET);
    const credentials = join(dataHome(), "credentials.json");
    expect(layers.warnings).toEqual([
      `Ignoring ${path} embeddings.dim: expected int`,
      `Unknown setting bogus in ${path}`,
      `Ignoring FISH_API_KEY in ${credentials}: expected a non-empty string`,
    ]);
    expect(warnings).toEqual([]);
  });

  test("installs nothing", () => {
    write("settings.yaml", "embeddings:\n  model: m\n");
    readSettingsLayers("milky-green");
    expect(envOptional("EMBED_MODEL")).toBeUndefined();
  });
});

describe("setting defaults", () => {
  test("lie beneath the files and the environment, from the persona installed", () => {
    write("settings.yaml", "persona: other\n");
    write("personas/other/persona.yaml", "identity:\n  name: Other\n");
    setSettingDefaults((persona) => ({ MEM0_AGENT_ID: persona.id, FISH_MODEL: "s1" }));
    installSettings();
    expect(envOptional("MEM0_AGENT_ID")).toBe("other");
    write("personas/other/persona.yaml", "memory:\n  agentId: shared\n");
    installSettings();
    expect(envOptional("MEM0_AGENT_ID")).toBe("shared");
    setEnv("MEM0_AGENT_ID", "from-env");
    expect(envOptional("MEM0_AGENT_ID")).toBe("from-env");
  });

  test("apply to what is installed now, and null removes them", () => {
    installSettings();
    expect(envOptional("MEM0_AGENT_ID")).toBeUndefined();
    setSettingDefaults((persona) => ({ MEM0_AGENT_ID: persona.id }));
    expect(envOptional("MEM0_AGENT_ID")).toBe("milky-green");
    setSettingDefaults(null);
    expect(envOptional("MEM0_AGENT_ID")).toBeUndefined();
  });

  test("never reach loadSettings' values", () => {
    setSettingDefaults(() => ({ MEM0_AGENT_ID: "x" }));
    expect(installSettings().values.has("MEM0_AGENT_ID")).toBe(false);
  });
});

test("envOverride reads only a non-empty environment variable", () => {
  write("settings.yaml", "embeddings:\n  model: from-file\n");
  installSettings();
  expect(envOverride("EMBED_MODEL")).toBeUndefined();
  setEnv("EMBED_MODEL", "");
  expect(envOverride("EMBED_MODEL")).toBeUndefined();
  setEnv("EMBED_MODEL", "from-env");
  expect(envOverride("EMBED_MODEL")).toBe("from-env");
});
