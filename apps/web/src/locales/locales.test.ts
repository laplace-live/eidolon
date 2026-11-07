// Every feature adds its own locale files; these keep the two languages in step and cover the
// codes and settings other packages define. Files are merged exactly as the app's loader does.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SETTINGS } from "@eidolon/config";
import { EVENT_CODES } from "@eidolon/ingest/progress";
import { CHECK_CODES, CHECK_WARNINGS, ERROR_CODES } from "../../../bot/src/local/api.ts";
import { CLIENT_ERROR_CODES } from "../lib/api";
import { buildCatalogs, type Catalog, LANGS, PLURAL_FORMS, placeholders } from "../lib/i18n";

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

const PLURAL = new RegExp(`_(?:${PLURAL_FORMS.join("|")})$`);

/** A language's keys, without the plural forms only some languages need. */
function baseKeys(catalog: Catalog): string[] {
  return Object.keys(catalog).filter((key) => !PLURAL.test(key));
}

test("both languages have the same keys", () => {
  const en: Catalog = catalogs.en;
  const zh: Catalog = catalogs["zh-CN"];
  expect(baseKeys(zh).filter((key) => !(key in en))).toEqual([]);
  expect(baseKeys(en).filter((key) => !(key in zh))).toEqual([]);
});

test("a plural form has its base string, with the same {placeholders}", () => {
  for (const lang of LANGS) {
    const catalog: Catalog = catalogs[lang];
    const orphans = Object.keys(catalog).filter((key) => {
      if (!PLURAL.test(key)) return false;
      const base = catalog[key.replace(PLURAL, "")];
      return (
        base === undefined || placeholders(base).join() !== placeholders(catalog[key] ?? "").join()
      );
    });
    expect(orphans).toEqual([]);
  }
});

test("a string has the same {placeholders} in both languages", () => {
  const differ = baseKeys(catalogs.en).filter(
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

test("every provider check's verdict and warning, and the fallbacks, has a string", () => {
  const keys = [
    ...CHECK_CODES.map((code) => `settings.check.${code}`),
    ...CHECK_WARNINGS.map((code) => `settings.check.warning.${code}`),
    "settings.check.passed",
    "settings.check.failed",
  ];
  expect(missing(keys)).toEqual(nothingMissing);
});

test("every SETTINGS row has a title", () => {
  expect(missing(SETTINGS.map((row) => `settings.${row.path}`))).toEqual(nothingMissing);
});
