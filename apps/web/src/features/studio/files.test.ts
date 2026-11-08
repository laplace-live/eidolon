import { describe, expect, test } from "bun:test";
import type { SettingRow } from "@/lib/api";
import {
  CUE_MODEL,
  cueClash,
  draftAfterSave,
  FACT_EXTENSIONS,
  factFileName,
  hasDeliveryCues,
  IMAGE_EXTENSIONS,
  IMAGE_TYPES,
  imageProblem,
  MAX_IMAGE_BYTES,
  nameProblem,
  previewable,
  previewUrl,
  renamed,
  stemOf,
  textCounts,
} from "./files";

describe("file names", () => {
  test("names the server takes", () => {
    for (const name of ["设定集.txt", "facts 2.txt", "a.TXT"]) {
      expect(nameProblem(name, FACT_EXTENSIONS)).toBeNull();
    }
    expect(nameProblem("坚果.webp", IMAGE_EXTENSIONS)).toBeNull();
  });

  test("names it refuses, and why", () => {
    for (const name of [
      "",
      ".hidden.txt",
      "a/b.txt",
      "a\\b.txt",
      "a:b.txt",
      "a\u0000.txt",
      " a.txt",
    ]) {
      expect(nameProblem(name, FACT_EXTENSIONS)).toBe("invalid");
    }
    expect(nameProblem(`${"a".repeat(125)}.txt`, FACT_EXTENSIONS)).toBe("invalid");
    expect(nameProblem("notes.md", FACT_EXTENSIONS)).toBe("extension");
    expect(nameProblem("notes", FACT_EXTENSIONS)).toBe("extension");
    expect(nameProblem("face.svg", IMAGE_EXTENSIONS)).toBe("extension");
  });

  test("a fact file gets .txt when it has no extension, and a friend's picture their name", () => {
    expect(factFileName(" 事件集 ")).toBe("事件集.txt");
    expect(factFileName("events.txt")).toBe("events.txt");
    expect(renamed("IMG_0001.JPG", "坚果")).toBe("坚果.jpg");
    expect(stemOf("坚果.png")).toBe("坚果");
    expect(stemOf("README")).toBe("README");
  });
});

test("images are PNG, JPEG or WebP, up to 20 MiB", () => {
  expect(imageProblem({ type: "image/png", size: MAX_IMAGE_BYTES })).toBeNull();
  expect(imageProblem({ type: "image/svg+xml", size: 10 })).toBe("type");
  expect(imageProblem({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1 })).toBe("size");
});

test("a reference shows when the server would serve its type", () => {
  expect(["day.png", "a.JPG", "b.jpeg", "c.webp"].map(previewable)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(["beach.gif", "photo.heic", "x.svg", "noext"].map(previewable)).toEqual([
    false,
    false,
    false,
    false,
  ]);
});

test("a picked image previews as an object URL of its type; any other file gets none", async () => {
  for (const type of IMAGE_TYPES) {
    const url = previewUrl(new File(["pixels"], "friend", { type }));
    expect(url).toStartWith("blob:");
    const response = await fetch(url as string);
    expect([response.headers.get("content-type"), await response.text()]).toEqual([type, "pixels"]);
    URL.revokeObjectURL(url as string);
  }
  for (const type of ["image/svg+xml", "text/html", ""]) {
    const page = new File(["<svg onload=alert(1)>"], "friend.png", { type });
    expect(previewUrl(page)).toBeNull();
  }
});

test("text counts characters, not UTF-16 units", () => {
  expect(textCounts("")).toEqual({ chars: 0, lines: 0 });
  expect(textCounts("奶绿🌸\n第二行")).toEqual({ chars: 7, lines: 2 });
});

test("a save takes the text as the server keeps it, but not over what was typed meanwhile", () => {
  expect(draftAfterSave("第一行", "第一行", "第一行\n")).toBe("第一行\n");
  expect(draftAfterSave("第一行，还在写", "第一行", "第一行\n")).toBe("第一行，还在写");
});

test("a prompt that teaches delivery cues is told apart from one that doesn't", () => {
  expect(hasDeliveryCues("用 `[温柔地安慰]` 这样的提示。")).toBe(true);
  expect(hasDeliveryCues("说话<emphasis>重读</emphasis>就好。")).toBe(true);
  expect(hasDeliveryCues("你是一个温柔的主播，说话简短。")).toBe(false);
});

describe("the voice model against the prompt's cues", () => {
  const cues = "用 `[温柔地安慰]` 这样的提示。";
  const row = (path: string, env: string, fields: Partial<SettingRow>): SettingRow => ({
    path,
    env,
    scope: "persona",
    kind: "string",
    title: path,
    value: null,
    source: "default",
    envValue: null,
    envName: null,
    envOverride: false,
    productionOnly: false,
    readOnly: false,
    ...fields,
  });
  /** Her voice rows: the model's fields, and the provider's. */
  const voice = (model: Partial<SettingRow>, provider: Partial<SettingRow> = {}): SettingRow[] => [
    row("voice.provider", "TTS_PROVIDER", provider),
    row("voice.model", "TTS_MODEL", model),
  ];

  test("persona.yaml's model, when it isn't the one that acts on cues", () => {
    expect(cueClash(voice({ value: "s2-pro" }), cues, [])).toEqual({
      kind: "model",
      model: "s2-pro",
    });
    expect(cueClash(voice({ value: CUE_MODEL }), cues, [])).toBeNull();
  });

  test("the environment's model, which she inherits only while her file sets none", () => {
    const inherited = { envValue: "s1", envName: "FISH_MODEL" };
    expect(cueClash(voice(inherited), cues, [])).toEqual({
      kind: "env",
      env: "FISH_MODEL",
      model: "s1",
    });
    expect(cueClash(voice({ envValue: CUE_MODEL, envName: "TTS_MODEL" }), cues, [])).toBeNull();
    expect(cueClash(voice({ ...inherited, value: CUE_MODEL }), cues, [])).toBeNull();
    expect(
      cueClash(voice({ value: "s2-pro", envValue: CUE_MODEL, envName: "TTS_MODEL" }), cues, []),
    ).toEqual({ kind: "model", model: "s2-pro" });
  });

  test("a second Fish account reads cues as Fish's default account does", () => {
    const accounts = [{ id: "fish-2", provider: "fish" }];
    expect(cueClash(voice({}, { value: "fish-2" }), cues, accounts)).toBeNull();
  });

  test("another provider's default model reads no cues", () => {
    expect(cueClash(voice({}, { value: "openai" }), cues, [])).toEqual({
      kind: "provider",
      provider: "OpenAI",
      model: "gpt-4o-mini-tts",
    });
  });

  test("unset, the default applies; and a prompt without cues clashes with nothing", () => {
    expect(cueClash(voice({}), cues, [])).toBeNull();
    expect(cueClash(voice({ value: "s2-pro", envValue: "s1" }), "说话简短。", [])).toBeNull();
    expect(cueClash(undefined, cues, [])).toBeNull();
    expect(cueClash(voice({ value: "s2-pro" }), undefined, [])).toBeNull();
  });
});
