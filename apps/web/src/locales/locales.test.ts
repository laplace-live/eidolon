// Every feature adds its own locale files; these keep the two languages in step and cover the
// codes and settings other packages define. Files are merged exactly as the app's loader does.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "@eidolon/config";
import { EVENT_CODES } from "@eidolon/ingest/progress";
import { ERROR_CODES } from "../../../bot/src/local/api.ts";
import { CLIENT_ERROR_CODES } from "../lib/api";
import { buildCatalogs, type Catalog, LANGS, placeholders } from "../lib/i18n";

const DIR = import.meta.dir;

function jsonFiles(folder: string): string[] {
  return readdirSync(join(DIR, folder))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

const folders = readdirSync(DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// What import.meta.glob("./*/*.json") hands the loader; an unknown folder throws here as in the app.
const catalogs = buildCatalogs(
  Object.fromEntries(
    folders.flatMap((folder) =>
      jsonFiles(folder).map((name) => [
        `./${folder}/${name}`,
        JSON.parse(readFileSync(join(DIR, folder, name), "utf8")),
      ]),
    ),
  ),
);

function missing(keys: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(
    LANGS.map((lang) => [lang, keys.filter((key) => !(key in catalogs[lang]))]),
  );
}

const nothingMissing = Object.fromEntries(LANGS.map((lang) => [lang, []]));

test("every locale folder is a language, and each has the same files", () => {
  expect(folders.sort()).toEqual([...LANGS].sort());
  expect(jsonFiles("zh-CN")).toEqual(jsonFiles("en"));
});

test("both languages have the same keys", () => {
  const en: Catalog = catalogs.en;
  const zh: Catalog = catalogs["zh-CN"];
  expect(Object.keys(zh).filter((key) => !(key in en))).toEqual([]);
  expect(Object.keys(en).filter((key) => !(key in zh))).toEqual([]);
});

test("a string has the same {placeholders} in both languages", () => {
  const differ = Object.keys(catalogs.en).filter(
    (key) =>
      placeholders(catalogs.en[key] ?? "").join() !==
      placeholders(catalogs["zh-CN"][key] ?? "").join(),
  );
  expect(differ).toEqual([]);
});

test("no string is blank", () => {
  for (const lang of LANGS) {
    expect(Object.entries(catalogs[lang]).filter(([, text]) => text.trim() === "")).toEqual([]);
  }
});

test("every EventCode a job reports has a string", () => {
  expect(missing(EVENT_CODES.map((code) => `events.${code}`))).toEqual(nothingMissing);
});

test("every error code the API sends or the client makes up, and the fallback, has a string", () => {
  const codes = [...ERROR_CODES, ...CLIENT_ERROR_CODES, "unknown"];
  expect(missing(codes.map((code) => `errors.${code}`))).toEqual(nothingMissing);
});

test("every SETTINGS row has a title", () => {
  expect(missing(SETTINGS.map((row) => `settings.${row.path}`))).toEqual(nothingMissing);
});
