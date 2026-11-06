import { describe, expect, test } from "bun:test";
import {
  PY_SPACE_CLASS,
  pyParseFloat,
  pyParseInt,
  pyStrip,
  SETTINGS,
  type SettingField,
} from "@eidolon/config";
import { FISH_MODELS as CHECKED_MODELS } from "../../../../bot/src/local/checks.ts";
import type { SettingRow } from "../../lib/api";
import {
  BASIC,
  changes,
  controlFor,
  draftOf,
  GROUPS,
  groupOf,
  optionsOf,
  parseDraft,
  REINDEX_PATHS,
  SPACE_CLASS,
  sections,
  staysInside,
  visibleRows,
} from "./controls";

function row(field: SettingField, extra: Partial<SettingRow> = {}): SettingRow {
  return {
    ...field,
    value: null,
    source: "default",
    envOverride: false,
    productionOnly: false,
    readOnly: false,
    ...extra,
  };
}

const field = (path: string): SettingField => {
  const found = SETTINGS.find((setting) => setting.path === path);
  if (!found) throw new Error(`no setting ${path}`);
  return found;
};

const control = (path: string) => controlFor(field(path));

/** How the bot's readers split a list or paths variable: on ",", Python-stripped, blanks dropped. */
function readerSplit(variable: string): string[] {
  return variable
    .split(",")
    .map((item) => pyStrip(item))
    .filter((item) => item !== "");
}

describe("the control for each kind", () => {
  test("every SETTINGS row gets one that writes a value its kind's reader accepts", () => {
    const allowed: Record<string, readonly string[]> = {
      string: ["text", "select", "timezone", "language", "voice"],
      int: ["integer"],
      float: ["number"],
      flag: ["flag"],
      list: ["list"],
      path: ["path"],
      paths: ["paths"],
    };
    const wrong = SETTINGS.filter(
      (setting) => !allowed[setting.kind]?.includes(controlFor(setting).type),
    ).map((setting) => setting.path);
    expect(wrong).toEqual([]);
  });

  test("known value sets are selects, and the path rule follows the scope", () => {
    expect(control("voice.model")).toEqual({
      type: "select",
      options: ["drama-3", "s2.1-pro", "s2.1-pro-free", "s2-pro", "s1"],
    });
    // The models the server's Fish check accepts: the select offers no other.
    expect(control("voice.model")).toMatchObject({ options: [...CHECKED_MODELS] });
    expect(control("sources.cookiesFromBrowser").type).toBe("select");
    expect(control("selfie.quality").type).toBe("select");
    expect(control("knowledge.rerank.enabled")).toEqual({ type: "flag" });
    expect(control("prompt")).toEqual({ type: "path", inPersona: true });
    expect(control("memory.historyDb")).toEqual({ type: "path", inPersona: false });
    expect(control("selfie.references")).toEqual({ type: "paths", inPersona: true });
    expect(control("memory.qdrant.port")).toEqual({ type: "integer", min: 1, max: 65535 });
  });

  test("a select keeps a file's value that isn't one of its choices", () => {
    const cookies = control("sources.cookiesFromBrowser");
    if (cookies.type !== "select") throw new Error("not a select");
    expect(optionsOf(cookies, "chrome:Profile 1").at(-1)).toBe("chrome:Profile 1");
    expect(optionsOf(cookies, "firefox")).toEqual([...cookies.options]);
    expect(optionsOf(cookies, "")).toEqual([...cookies.options]);
  });
});

describe("numbers parse as Python's int() and float() do", () => {
  const ints = [
    "12",
    " 7 ",
    "+5",
    "-3",
    "0",
    "1_000",
    "１２",
    "1__0",
    "_1",
    "1_",
    "1.0",
    "1e3",
    "0x10",
    "12a",
    "- 3",
  ];
  const floats = [
    "0.5",
    ".5",
    "5.",
    "-1.25",
    "1e-3",
    "2E+2",
    "1_0.5",
    "７.５",
    "1._5",
    ".",
    "e3",
    "1e",
    "0.5.1",
    "abc",
  ];

  test("an integer is accepted exactly when int() would read it", () => {
    for (const text of ints) {
      const parsed = parseDraft(text, { type: "integer" });
      const python = pyParseInt(text);
      expect([text, parsed.ok ? parsed.value : null]).toEqual([text, python]);
    }
  });

  test("a number is accepted exactly when float() would read it as a finite value", () => {
    for (const text of floats) {
      const parsed = parseDraft(text, { type: "number" });
      const python = pyParseFloat(text);
      expect([text, parsed.ok ? parsed.value : null]).toEqual([text, python]);
    }
  });

  test("inf and nan are refused: JSON can't carry them, and null would remove the key", () => {
    for (const text of ["inf", "-Infinity", "nan"]) {
      expect(Number.isFinite(pyParseFloat(text))).toBe(false);
      expect(parseDraft(text, { type: "number" })).toEqual({
        ok: false,
        error: "settings.form.invalid.number",
      });
    }
  });

  test("bounds, and integers past 2^53", () => {
    const port = control("memory.qdrant.port");
    expect(parseDraft("6333", port)).toEqual({ ok: true, value: 6333 });
    expect(parseDraft("0", port)).toEqual({ ok: false, error: "settings.form.invalid.min" });
    expect(parseDraft("65536", port)).toEqual({ ok: false, error: "settings.form.invalid.max" });
    expect(parseDraft("9007199254740993", { type: "integer" }).ok).toBe(false);
  });

  test("an empty draft removes the key", () => {
    expect(parseDraft("  ", { type: "integer" })).toEqual({ ok: true, value: null });
    expect(parseDraft("", { type: "number" })).toEqual({ ok: true, value: null });
  });
});

describe("lists and paths round-trip through the reader", () => {
  test("the whitespace stripped is Python's, as @eidolon/config strips it", () => {
    expect(SPACE_CLASS).toBe(PY_SPACE_CLASS);
  });

  test("a list's items come back from the joined variable unchanged", () => {
    for (const draft of ["a, b,,c ", "*设定集.txt, *事件集.txt", "\u3000x\u3000,\u00a0y", "solo"]) {
      const parsed = parseDraft(draft, { type: "list" });
      if (!parsed.ok || !Array.isArray(parsed.value)) throw new Error(`not a list: ${draft}`);
      expect(readerSplit(parsed.value.join(","))).toEqual(parsed.value);
    }
    expect(parseDraft(" , ,", { type: "list" })).toEqual({ ok: true, value: null });
  });

  test("a list held as one comma string shows as its items", () => {
    expect(draftOf("anime_audio,karaoke", { type: "list" })).toBe("anime_audio, karaoke");
    expect(draftOf(["*.txt", "notes.txt"], { type: "list" })).toBe("*.txt, notes.txt");
  });

  test("paths are one per line, and a comma, which the reader would split on, is refused", () => {
    const paths = control("selfie.references");
    expect(parseDraft("references/outfits/day.png\n\n  night.png  ", paths)).toEqual({
      ok: true,
      value: ["references/outfits/day.png", "night.png"],
    });
    expect(parseDraft("a,b.png", paths)).toEqual({
      ok: false,
      error: "settings.form.invalid.comma",
    });
    expect(draftOf("a.png, b.png", paths)).toBe("a.png\nb.png");
  });

  test("a persona's paths stay in her folder; URLs pass as the reader passes them", () => {
    const paths = control("selfie.references");
    for (const bad of ["~/x.png", "/etc/passwd", "../../credentials.json", "a/../../b", "C:\\x"]) {
      expect(parseDraft(bad, paths)).toEqual({
        ok: false,
        error: "settings.form.invalid.relative",
      });
      expect(parseDraft(bad, control("prompt")).ok).toBe(false);
    }
    expect(parseDraft("https://example.com/a.png", paths).ok).toBe(true);
    expect(parseDraft("prompt-v2.md", control("prompt"))).toEqual({
      ok: true,
      value: "prompt-v2.md",
    });
    expect(parseDraft("~/eidolon/history.db", control("memory.historyDb")).ok).toBe(true);
  });

  test("staysInside", () => {
    expect(staysInside("a/./b/../c")).toBe(true);
    expect(staysInside("a/..")).toBe(true);
    expect(staysInside("..")).toBe(false);
    expect(staysInside("a\\..\\..\\b")).toBe(false);
  });
});

describe("the other controls", () => {
  test("a flag is default, on or off, as envFlag reads the words", () => {
    const flag = control("knowledge.gate.enabled");
    expect([true, "Yes", " on ", "1"].map((value) => draftOf(value, flag))).toEqual([
      "on",
      "on",
      "on",
      "on",
    ]);
    expect([false, "no", "OFF", "0"].map((value) => draftOf(value, flag))).toEqual([
      "off",
      "off",
      "off",
      "off",
    ]);
    expect(draftOf("maybe", flag)).toBe("");
    expect(parseDraft("on", flag)).toEqual({ ok: true, value: true });
    expect(parseDraft("off", flag)).toEqual({ ok: true, value: false });
    expect(parseDraft("", flag)).toEqual({ ok: true, value: null });
  });

  test("time zones, language hints and voice ids", () => {
    expect(parseDraft("Asia/Shanghai", control("identity.timezone")).ok).toBe(true);
    expect(parseDraft("Mars/Olympus", control("identity.timezone")).ok).toBe(false);
    expect(parseDraft("zh", control("transcription.language")).ok).toBe(true);
    expect(parseDraft("none", control("transcription.language")).ok).toBe(true);
    expect(parseDraft("zh-CN", control("transcription.language")).ok).toBe(false);
    const voice = control("voice.voiceId");
    expect(parseDraft("7f92f8afb8ec43bf81429cc1c9199cb1", voice).ok).toBe(true);
    expect(parseDraft("https://fish.audio/m/7f92f8afb8ec43bf81429cc1c9199cb1", voice).ok).toBe(
      false,
    );
  });

  test("text is stripped, and blank removes the key", () => {
    expect(parseDraft("  ~google/gemini-flash-latest ", { type: "text" })).toEqual({
      ok: true,
      value: "~google/gemini-flash-latest",
    });
    expect(parseDraft("\u3000", { type: "text" })).toEqual({ ok: true, value: null });
  });
});

describe("layout", () => {
  test("every row the form shows has a group of its own, so none lands in Other", () => {
    const rows = SETTINGS.map((setting) => row(setting));
    const shown = [...visibleRows(rows, "app"), ...visibleRows(rows, "persona")];
    expect(shown.filter((r) => groupOf(r.path, r.scope) === "other").map((r) => r.path)).toEqual(
      [],
    );
    expect(GROUPS.at(-1)).toBe("other");
  });

  test("BASIC and REINDEX_PATHS name real rows", () => {
    const paths = new Set(SETTINGS.map((setting) => setting.path));
    expect([...BASIC, ...REINDEX_PATHS].filter((path) => !paths.has(path))).toEqual([]);
  });

  test("the form leaves out production-only rows, the persona row and the other scope", () => {
    const rows = SETTINGS.map((setting) =>
      row(setting, { productionOnly: setting.path.startsWith("mcp.") }),
    );
    const app = visibleRows(rows, "app").map((r) => r.path);
    expect(app).not.toContain("persona");
    expect(app.some((path) => path.startsWith("mcp."))).toBe(false);
    expect(app).toContain("local.viewerName");
    expect(app.every((path) => field(path).scope === "app")).toBe(true);
    expect(
      visibleRows(rows, "persona", ["voice.model", "nope", "prompt"]).map((r) => r.path),
    ).toEqual(["voice.model", "prompt"]);
  });

  test("sections split basic from advanced, in group order", () => {
    const rows = ["mind.model", "prompt", "voice.voiceId", "hearing.model"].map((path) =>
      row(field(path)),
    );
    const { basic, advanced } = sections(rows);
    expect(basic.map((s) => [s.group, s.rows.map((r) => r.path)])).toEqual([
      ["voice", ["voice.voiceId"]],
      ["models", ["mind.model"]],
    ]);
    expect(advanced.map((s) => [s.group, s.rows.map((r) => r.path)])).toEqual([
      ["persona", ["prompt"]],
      ["models", ["hearing.model"]],
    ]);
  });
});

describe("changes", () => {
  const rows = [
    row(field("memory.qdrant.port"), { value: 6333, source: "app" }),
    row(field("memory.qdrant.host")),
    row(field("embeddings.model"), { envOverride: true }),
    row(field("sources.ytDlp"), { readOnly: true }),
    row(field("knowledge.facts.files"), { scope: "persona", value: "*.txt" }),
  ];

  test("sends only what was edited and differs, with null for a cleared value", () => {
    expect(
      changes(rows, {
        "memory.qdrant.port": "6333",
        "memory.qdrant.host": "127.0.0.1",
        "knowledge.facts.files": "",
      }),
    ).toEqual({
      values: { "memory.qdrant.host": "127.0.0.1", "knowledge.facts.files": null },
      errors: {},
    });
  });

  test("skips rows the environment or the API owns, and reports drafts that don't parse", () => {
    expect(
      changes(rows, {
        "embeddings.model": "x",
        "sources.ytDlp": "/bin/sh",
        "memory.qdrant.port": "port",
      }),
    ).toEqual({ values: {}, errors: { "memory.qdrant.port": "settings.form.invalid.integer" } });
  });
});
