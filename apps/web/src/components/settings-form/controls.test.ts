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
  cardSections,
  changes,
  controlFor,
  draftOf,
  envDraft,
  GROUPS,
  groupOf,
  optionsOf,
  originOf,
  parseDraft,
  REINDEX_PATHS,
  SPACE_CLASS,
  staysInside,
  visibleRows,
} from "./controls";

function row(field: SettingField, extra: Partial<SettingRow> = {}): SettingRow {
  return {
    ...field,
    value: null,
    source: "default",
    envValue: null,
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

  test("REINDEX_PATHS name real rows", () => {
    const paths = new Set(SETTINGS.map((setting) => setting.path));
    expect(REINDEX_PATHS.filter((path) => !paths.has(path))).toEqual([]);
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

describe("where a field's value comes from", () => {
  const voice = (extra: Partial<SettingRow>) => row(field("voice.voiceId"), extra);
  const host = (extra: Partial<SettingRow>) => row(field("memory.qdrant.host"), extra);

  test("a persona row inherits the environment's value while her draft is empty", () => {
    expect(originOf(voice({ envValue: "env-voice" }), "")).toBe("inherited");
    expect(originOf(voice({ envValue: "env-voice" }), " \u3000")).toBe("inherited");
  });

  test("her own value overrides the environment's, as soon as she types one", () => {
    const set = voice({ envValue: "env-voice", value: "mine", source: "persona" });
    expect(originOf(set, "mine")).toBe("overrides");
    // Cleared but not saved: the environment's value is what she would get.
    expect(originOf(set, "")).toBe("inherited");
    expect(originOf(voice({ envValue: "env-voice" }), "typed")).toBe("overrides");
  });

  test("without an environment value a row says nothing of it", () => {
    expect(originOf(voice({}), "")).toBe("own");
    expect(originOf(voice({ value: "mine", source: "persona" }), "mine")).toBe("own");
    expect(originOf(host({}), "")).toBe("own");
  });

  test("only an app row the environment overrides, or a read-only one, is locked", () => {
    expect(originOf(host({ envValue: "10.0.0.2", envOverride: true }), "")).toBe("locked");
    expect(originOf(host({ envValue: "10.0.0.2", envOverride: true }), "x")).toBe("locked");
    expect(originOf(row(field("sources.ytDlp"), { readOnly: true }), "")).toBe("readOnly");
    // A persona row is never overridden, whatever the environment holds.
    expect(originOf(voice({ envValue: "env-voice", envOverride: false }), "")).toBe("inherited");
  });

  test("the environment's value as each control shows it", () => {
    expect(envDraft(voice({ envValue: "env-voice" }), control("voice.voiceId"))).toBe("env-voice");
    expect(envDraft(voice({}), control("voice.voiceId"))).toBeNull();
    const rerank = control("knowledge.rerank.enabled");
    expect(envDraft({ envValue: "true" }, rerank)).toBe("on");
    expect(envDraft({ envValue: "0" }, rerank)).toBe("off");
    expect(envDraft({ envValue: "*.txt,notes.txt" }, control("knowledge.facts.files"))).toBe(
      "*.txt, notes.txt",
    );
    expect(envDraft({ envValue: "a.png,b.png" }, control("selfie.references"))).toBe(
      "a.png\nb.png",
    );
  });
});

describe("a settings card's rows", () => {
  const rows = SETTINGS.map((setting) =>
    row(setting, { productionOnly: setting.path.startsWith("mcp.") }),
  );
  const paths = (sections: ReturnType<typeof cardSections>) =>
    sections.map((section) => [
      section.group,
      section.lines.map((line) => line.map((r) => r.path)),
    ]);

  test("named rows come in the given order, an array of paths as one line", () => {
    const card = cardSections(rows, "app", [
      ["memory.qdrant.host", "memory.qdrant.port"],
      "memory.qdrant.collection",
      "memory.historyDb",
    ]);
    expect(paths(card)).toEqual([
      [
        null,
        [
          ["memory.qdrant.host", "memory.qdrant.port"],
          ["memory.qdrant.collection"],
          ["memory.historyDb"],
        ],
      ],
    ]);
  });

  test("rows of the other scope, hidden or production-only rows, and unknown paths drop out", () => {
    const card = cardSections(rows, "persona", [
      "voice.model",
      "memory.qdrant.host",
      ["nope", "mind.model"],
      "mcp.allowedHosts",
    ]);
    expect(paths(card)).toEqual([[null, [["voice.model"], ["mind.model"]]]]);
    expect(cardSections(rows, "app", ["persona", "mcp.allowedHosts"])).toEqual([]);
  });

  test("without paths, every shown row of the scope but the excluded ones, by group", () => {
    const shown = visibleRows(rows, "persona").map((r) => r.path);
    const exclude = shown.filter((path) => !path.startsWith("memory.") && path !== "prompt");
    const card = cardSections(rows, "persona", undefined, exclude);
    expect(paths(card)).toEqual([
      ["persona", [["prompt"]]],
      [
        "memory",
        visibleRows(rows, "persona")
          .filter((r) => r.path.startsWith("memory."))
          .map((r) => [r.path]),
      ],
    ]);
  });

  test("one group needs no legend, and exclude applies to named rows too", () => {
    const card = cardSections(rows, "persona", undefined, [
      ...visibleRows(rows, "persona")
        .map((r) => r.path)
        .filter((path) => !path.startsWith("selfie.")),
    ]);
    expect(card).toHaveLength(1);
    expect(card[0]?.group).toBeNull();
    expect(
      paths(cardSections(rows, "persona", ["voice.model", "mind.model"], ["mind.model"])),
    ).toEqual([[null, [["voice.model"]]]]);
  });
});
