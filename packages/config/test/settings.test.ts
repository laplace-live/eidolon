import "./isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activePersona,
  dataHome,
  envEntries,
  envInt,
  envOptional,
  envStr,
  fillPersonaText,
  installSettings,
  loadSettings,
  logger,
  PROJECT_ROOT,
  personaFolders,
  personaIds,
  personaPath,
  resetSettings,
  SETTINGS,
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
const OWN = () => join(dataHome(), "personas", "milky-green");

describe("with no files of the user's own", () => {
  test("the milky-green template is the active persona", () => {
    const loaded = loadSettings();
    expect(loaded.persona.id).toBe("milky-green");
    expect(loaded.persona.identity).toEqual({
      name: "明前奶绿",
      shortName: "奶绿",
      fans: "奶糖花",
      summary:
        "明前奶绿, a Chinese VTuber who streams on Bilibili, runs a fictional flower shop " +
        "(拉普拉斯花店) whose manager is her cat 坚果, and calls her fans 奶糖花",
      viewerLine: "今天来花店的{fans}叫「{viewer}」（B站UID:{uid}）。",
    });
    expect(Object.keys(loaded.persona.gateQuestions)).toEqual(["about_her"]);
    expect([...loaded.values]).toEqual([
      ["PERSONA_TIMEZONE", "Asia/Shanghai"],
      ["FACTS_FILES", "*设定集.txt,*事件集.txt"],
      ["FACTS_SUBJECT", "明前奶[绿黑]"],
    ]);
    expect(loaded.files.persona).toBe(join(TEMPLATE, "persona.yaml"));
    expect(warnings).toEqual([]);
  });

  test("its files come from the template, its data from the user's folder", () => {
    expect(personaPath("prompt.md")).toBe(join(TEMPLATE, "prompt.md"));
    expect(personaPath("index")).toBe(join(OWN(), "index"));
    expect(personaFolders("references")).toEqual([join(TEMPLATE, "references")]);
    expect(personaIds()).toEqual(["milky-green"]);
  });
});

describe("layers", () => {
  test("persona.yaml sets a value the environment overrides; a blank variable defers", () => {
    write("personas/milky-green/persona.yaml", "voice:\n  model: s2\n");
    installSettings();
    expect(envStr("FISH_MODEL", "drama-3")).toBe("s2");
    setEnv("FISH_MODEL", "drama-3-pro");
    expect(envStr("FISH_MODEL", "drama-3")).toBe("drama-3-pro");
    setEnv("FISH_MODEL", "");
    expect(envStr("FISH_MODEL", "drama-3")).toBe("s2");
  });

  test("settings.yaml holds the install's settings", () => {
    write(
      "settings.yaml",
      "access:\n  realIpHeader: cf-connecting-ip\n  allowedOrigins: [https://a.example, https://b.example]\n",
    );
    installSettings();
    expect(envOptional("EIDOLON_REAL_IP_HEADER")).toBe("cf-connecting-ip");
    expect(envOptional("PIPECAT_ALLOWED_ORIGINS")).toBe("https://a.example,https://b.example");
  });

  test("a file's value parses and warns as the same value from the environment would", () => {
    write("personas/milky-green/persona.yaml", "knowledge:\n  factsCandidates: abc\n");
    installSettings();
    expect(envInt("PERSONA_FACTS_CANDIDATES", 30)).toBe(30);
    expect(warnings).toEqual([
      "PERSONA_FACTS_CANDIDATES='abc' is not a valid int; using default 30",
    ]);
  });

  test("the user's persona.yaml replaces the template's whole; unset identity fields default", () => {
    write("personas/milky-green/persona.yaml", "identity:\n  name: 小绿\n");
    const { identity, gateQuestions } = loadSettings().persona;
    expect(identity).toEqual({
      name: "小绿",
      shortName: "小绿",
      fans: "观众",
      summary: "",
      viewerLine: "正在和你聊天的{fans}叫「{viewer}」（UID:{uid}）。",
    });
    expect(gateQuestions).toEqual({});
  });

  test("an explicit empty viewerLine stays empty", () => {
    write("personas/milky-green/persona.yaml", 'identity:\n  viewerLine: ""\n');
    expect(loadSettings().persona.identity.viewerLine).toBe("");
  });

  test("shortName is the name unless set", () => {
    write("personas/milky-green/persona.yaml", "identity:\n  name: 小绿\n  shortName: 绿\n");
    expect(loadSettings().persona.identity.shortName).toBe("绿");
  });

  test("offline chain settings: lists join, [] reads as unset, install paths in the home", () => {
    write(
      "settings.yaml",
      [
        "refine:",
        "  baseUrl: https://example.test/v1",
        "sources:",
        "  ytDlp: bin/yt-dlp-custom",
        "  cookiesFromBrowser: none",
        "  cookiesFile: /srv/cookies.txt",
        "",
      ].join("\n"),
    );
    write(
      "personas/milky-green/persona.yaml",
      [
        "knowledge:",
        "  facts:",
        "    files: []",
        "    subject: 小[绿黑]",
        "  archive:",
        "    skipTypes: [karaoke, anime_audio]",
        "transcription:",
        "  model: stt-async-v4",
        "refine:",
        "  model: some/model",
        "  concurrency: 3",
        "",
      ].join("\n"),
    );
    installSettings();
    expect(envOptional("FACTS_FILES")).toBeUndefined();
    expect(envOptional("FACTS_SUBJECT")).toBe("小[绿黑]");
    expect(envOptional("INGEST_SKIP_TYPES")).toBe("karaoke,anime_audio");
    expect(envOptional("SONIOX_ASYNC_MODEL")).toBe("stt-async-v4");
    expect(envOptional("REFINE_MODEL")).toBe("some/model");
    expect(envInt("REFINE_CONCURRENCY", 8)).toBe(3);
    expect(envOptional("REFINE_BASE_URL")).toBe("https://example.test/v1");
    expect(envOptional("YT_DLP_PATH")).toBe(join(dataHome(), "bin/yt-dlp-custom"));
    expect(envOptional("YT_DLP_COOKIES_FROM_BROWSER")).toBe("none");
    expect(envOptional("YT_DLP_COOKIES")).toBe("/srv/cookies.txt");
    expect(warnings).toEqual([]);
  });

  test("voice.styles become FISH_VOICE_ID_<STYLE>, visible to a scan of the environment", () => {
    write(
      "personas/milky-green/persona.yaml",
      "voice:\n  voiceId: base\n  styles:\n    gentle: soft-id\n",
    );
    installSettings();
    const entries = new Map(envEntries());
    expect(entries.get("FISH_VOICE_ID")).toBe("base");
    expect(entries.get("FISH_VOICE_ID_GENTLE")).toBe("soft-id");
  });
});

describe("paths", () => {
  test("persona paths resolve in the persona folder, the user's copy first", () => {
    write("personas/milky-green/persona.yaml", "prompt: prompt.md\nknowledge:\n  index: index\n");
    let loaded = loadSettings();
    expect(loaded.values.get("PERSONA_FILE")).toBe(join(TEMPLATE, "prompt.md"));
    expect(loaded.values.get("LANCEDB_PATH")).toBe(join(OWN(), "index"));
    write("personas/milky-green/prompt.md", "mine");
    loaded = loadSettings();
    expect(loaded.values.get("PERSONA_FILE")).toBe(join(OWN(), "prompt.md"));
  });

  test("install paths resolve in the data home; absolute and ~ paths stand alone", () => {
    write("settings.yaml", "memory:\n  historyDb: mem0/h.db\n");
    expect(loadSettings().values.get("MEM0_HISTORY_DB_PATH")).toBe(join(dataHome(), "mem0/h.db"));
    write("settings.yaml", "memory:\n  historyDb: /srv/h.db\n");
    expect(loadSettings().values.get("MEM0_HISTORY_DB_PATH")).toBe("/srv/h.db");
  });

  test("selfie.references keep URLs and resolve files", () => {
    write(
      "personas/milky-green/persona.yaml",
      "selfie:\n  references: [https://e/x.png, refs/a.png]\n",
    );
    expect(loadSettings().values.get("SELFIE_REFERENCE_IMAGES")).toBe(
      `https://e/x.png,${join(OWN(), "refs/a.png")}`,
    );
  });
});

describe("credentials", () => {
  test("credentials.json supplies secrets beneath the environment", () => {
    const path = write("credentials.json", '{"OPENROUTER_API_KEY": "sk-file"}');
    chmodSync(path, 0o600);
    installSettings();
    expect(envOptional("OPENROUTER_API_KEY")).toBe("sk-file");
    setEnv("OPENROUTER_API_KEY", "sk-env");
    expect(envOptional("OPENROUTER_API_KEY")).toBe("sk-env");
    expect(warnings).toEqual([]);
  });

  test("REFINE_API_KEY is a credential", () => {
    chmodSync(write("credentials.json", '{"REFINE_API_KEY": "sk-refine"}'), 0o600);
    expect(loadSettings().values.get("REFINE_API_KEY")).toBe("sk-refine");
    expect(warnings).toEqual([]);
  });

  test("a non-credential is refused, and a file others can read is flagged", () => {
    const path = write("credentials.json", '{"FISH_MODEL": "s2", "FISH_API_KEY": "k"}');
    chmodSync(path, 0o644);
    const loaded = loadSettings();
    expect(loaded.values.get("FISH_MODEL")).toBeUndefined();
    expect(loaded.values.get("FISH_API_KEY")).toBe("k");
    expect(warnings).toEqual([
      `${path} is readable by other users; run \`chmod 600 ${path}\``,
      `Ignoring FISH_MODEL in ${path}: not a credential`,
    ]);
  });

  test("YAML never carries a secret", () => {
    expect(SETTINGS.some((s) => s.env.endsWith("_API_KEY") || s.env.endsWith("_TOKEN"))).toBe(
      false,
    );
  });
});

describe("mistakes", () => {
  test("a misspelled key and a wrong type warn and are ignored", () => {
    const path = write(
      "personas/milky-green/persona.yaml",
      "voice:\n  modle: s2\nmind:\n  model: [a]\n",
    );
    expect([...loadSettings().values]).toEqual([]);
    expect(warnings).toEqual([
      `Ignoring ${path} mind.model: expected string`,
      `Unknown setting voice.modle in ${path}`,
    ]);
  });

  test("typos and wrong shapes inside identity, gate questions and voice styles warn", () => {
    const path = write(
      "personas/milky-green/persona.yaml",
      [
        "identity:",
        "  nmae: 小绿",
        "knowledge:",
        "  gate:",
        "    questions:",
        "      about_he: x",
        "      her_past: [x]",
        "voice:",
        "  styles: gentle",
      ].join("\n"),
    );
    const { persona } = loadSettings();
    expect(persona.identity.name).toBe("milky-green");
    expect(persona.gateQuestions).toEqual({});
    expect(warnings).toEqual([
      `Ignoring ${path} voice.styles: expected a mapping`,
      `Unknown setting identity.nmae in ${path}`,
      `Unknown setting knowledge.gate.questions.about_he in ${path}`,
      `Ignoring ${path} knowledge.gate.questions.her_past: expected string`,
    ]);
  });

  test("a non-string credential warns without its value; a blank one is quietly unset", () => {
    const path = write("credentials.json", '{"SONIOX_API_KEY": 123456, "FISH_API_KEY": ""}');
    chmodSync(path, 0o600);
    expect(loadSettings().values.has("SONIOX_API_KEY")).toBe(false);
    expect(warnings).toEqual([`Ignoring SONIOX_API_KEY in ${path}: expected a non-empty string`]);
  });

  test("a shared credentials file is flagged even when it fails to parse", () => {
    const path = write("credentials.json", '{"OPENROUTER_API_KEY": "sk-');
    chmodSync(path, 0o644);
    loadSettings();
    expect(warnings[0]).toBe(`${path} is readable by other users; run \`chmod 600 ${path}\``);
    expect(warnings[1]).toStartWith(`Ignoring ${path}: `);
  });

  test("malformed YAML counts as empty", () => {
    const templateOnly = [...loadSettings().values];
    const path = write("settings.yaml", "access: [unclosed\n");
    expect([...loadSettings().values]).toEqual(templateOnly);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toStartWith(`Ignoring ${path}: `);
  });
});

describe("choosing the persona", () => {
  test("EIDOLON_PERSONA, then settings.yaml's persona, then milky-green", () => {
    write("personas/other/persona.yaml", "identity:\n  name: Other\n");
    expect(personaIds()).toEqual(["milky-green", "other"]);
    expect(loadSettings().persona.id).toBe("milky-green");
    write("settings.yaml", "persona: other\n");
    expect(loadSettings().persona.identity.name).toBe("Other");
    setEnv("EIDOLON_PERSONA", "milky-green");
    expect(loadSettings().persona.id).toBe("milky-green");
  });

  test("activePersona reads the files once until reset", () => {
    expect(activePersona().id).toBe("milky-green");
    write("settings.yaml", "persona: other\n");
    write("personas/other/persona.yaml", "identity:\n  name: Other\n");
    expect(activePersona().id).toBe("milky-green");
    resetSettings();
    expect(activePersona().id).toBe("other");
  });
});

test("fillPersonaText fills known placeholders and leaves the rest", () => {
  expect(fillPersonaText("{fans}叫「{viewer}」{nope}", { fans: "奶糖花", viewer: "小A" })).toBe(
    "奶糖花叫「小A」{nope}",
  );
});

test("docs/personas.md documents every setting, under its own scope", async () => {
  const doc = await Bun.file(join(PROJECT_ROOT, "docs", "personas.md")).text();
  const [persona, app] = [doc.indexOf("## persona.yaml"), doc.indexOf("## settings.yaml")];
  for (const setting of SETTINGS) {
    const row = `| \`${setting.path}\` | \`${setting.env}\` | ${setting.kind} | ${setting.title} |`;
    const at = doc.indexOf(row);
    expect(at, row).toBeGreaterThan(-1);
    expect(setting.scope === "persona" ? at > persona && at < app : at > app, row).toBe(true);
  }
});
