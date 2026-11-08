// The catalogs `bun run i18n` extracts: every message translated with the same placeholders, and
// every SETTINGS row titled. Records keyed by a union type cover the other codes at compile time.
import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "@eidolon/config";
import { linguiMacro } from "@/test/lingui-macro";
import { LANGS } from "./i18n";

interface Entry {
  readonly context: string;
  readonly id: string;
  readonly text: string;
  readonly obsolete: boolean;
}

function unquote(line: string): string {
  return JSON.parse(line.slice(line.indexOf('"')));
}

/** A .po catalog's entries, its header left out. */
function catalog(lang: string): Entry[] {
  const entries: Entry[] = [];
  let current: { context: string; id: string; text: string; obsolete: boolean } | null = null;
  let field: "context" | "id" | "text" = "id";
  const flush = () => {
    if (current !== null && current.id !== "") entries.push(current);
    current = null;
  };
  for (const raw of readFileSync(join(import.meta.dir, `${lang}.po`), "utf8").split("\n")) {
    const obsolete = raw.startsWith("#~ ");
    const line = obsolete ? raw.slice(3) : raw;
    if (line.startsWith("msgctxt ")) {
      flush();
      current = { context: unquote(line), id: "", text: "", obsolete };
      field = "context";
    } else if (line.startsWith("msgid ")) {
      if (current === null || field !== "context") flush();
      current ??= { context: "", id: "", text: "", obsolete };
      current.id = unquote(line);
      field = "id";
    } else if (line.startsWith("msgstr ")) {
      if (current !== null) current.text = unquote(line);
      field = "text";
    } else if (line.startsWith('"') && current !== null) {
      current[field] += unquote(line);
    }
  }
  flush();
  return entries;
}

const key = (entry: Entry) => `${entry.context}\u0004${entry.id}`;

/** The ICU arguments and the <0> tags a message names, which a translation must keep. */
function slots(message: string): string {
  const names = [...message.matchAll(/\{(\w+)[,}]/g)].map((match) => match[1]);
  const tags = [...message.matchAll(/<(\/?\d+)\/?>/g)].map((match) => match[1]);
  return [...new Set([...names, ...tags])].sort().join(" ");
}

const english = catalog("en");
const chinese = catalog("zh-Hans");

test("both catalogs hold the same messages, none of them obsolete", () => {
  expect(LANGS).toEqual(["en", "zh-Hans"]);
  expect(english.length).toBeGreaterThan(0);
  expect(chinese.map(key).sort()).toEqual(english.map(key).sort());
  expect([...english, ...chinese].filter((entry) => entry.obsolete).map(key)).toEqual([]);
});

test("every message has a Chinese translation with the same placeholders and tags", () => {
  expect(chinese.filter((entry) => entry.text.trim() === "").map((entry) => entry.id)).toEqual([]);
  const differ = chinese.filter((entry) => slots(entry.id) !== slots(entry.text));
  expect(differ.map((entry) => `${entry.id} → ${entry.text}`)).toEqual([]);
});

test("every SETTINGS row has a title, and help only for rows there are", async () => {
  mock.module("@lingui/core/macro", linguiMacro);
  const { SETTING_HELP, SETTING_TITLES } = await import("@/components/settings-form/labels");
  const paths = SETTINGS.map((row) => row.path);
  expect(paths.filter((path) => !(path in SETTING_TITLES))).toEqual([]);
  expect(Object.keys(SETTING_HELP).filter((path) => !paths.includes(path))).toEqual([]);
});
