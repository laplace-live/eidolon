import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CREDENTIALS } from "@eidolon/config";
import { CHECK_CODES, CHECK_WARNINGS, REQUIRED_KEYS } from "../../../../bot/src/local/api.ts";
import { LANGS } from "../../lib/i18n";
import {
  CHECK_OF,
  checkTone,
  KEY_PAGES,
  OPTIONAL,
  PRODUCTION_ONLY,
  REQUIRED,
  verdictKey,
  warningKey,
} from "./credentials";

test("the required keys are the API's", () => {
  expect(REQUIRED).toEqual(REQUIRED_KEYS);
});

test("every credential is listed exactly once, so a new one has to be placed", () => {
  const listed = [...REQUIRED, ...OPTIONAL, ...PRODUCTION_ONLY];
  expect(new Set(listed).size).toBe(listed.length);
  expect([...listed].sort()).toEqual([...CREDENTIALS].sort());
});

test("checks exist only for listed keys, and the pages are https", () => {
  expect(Object.keys(CHECK_OF).filter((name) => !CREDENTIALS.includes(name))).toEqual([]);
  expect(Object.keys(CHECK_OF).filter((name) => PRODUCTION_ONLY.includes(name))).toEqual([]);
  for (const pages of Object.values(KEY_PAGES)) {
    expect(new URL(pages.key).protocol).toBe("https:");
    expect(new URL(pages.credit).protocol).toBe("https:");
  }
});

test("checkTone", () => {
  expect(checkTone({ ok: false, warnings: [] })).toBe("error");
  expect(checkTone({ ok: true, warnings: [{ code: "free-tier", message: "" }] })).toBe("warn");
  expect(checkTone({ ok: true, warnings: [] })).toBe("ok");
});

test("a verdict uses the provider's string, then the code's, then passed or failed", () => {
  const known = new Set([
    "settings.check.soniox.invalid-key",
    "settings.check.invalid-key",
    "settings.check.warning.free-tier",
  ]);
  const has = (key: string) => known.has(key);
  expect(verdictKey("soniox", { ok: false, code: "invalid-key" }, has)).toBe(
    "settings.check.soniox.invalid-key",
  );
  expect(verdictKey("fish", { ok: false, code: "invalid-key" }, has)).toBe(
    "settings.check.invalid-key",
  );
  expect(verdictKey("fish", { ok: false, code: "teapot" }, has)).toBe("settings.check.failed");
  expect(verdictKey("fish", { ok: true, code: "teapot" }, has)).toBe("settings.check.passed");
  expect(warningKey("free-tier", has)).toBe("settings.check.warning.free-tier");
  expect(warningKey("teapot", has)).toBeNull();
});

test("every check verdict and warning the API sends has a string in both languages", () => {
  for (const lang of LANGS) {
    const path = join(import.meta.dir, "../../locales", lang, "settings.json");
    const strings: Record<string, string> = JSON.parse(readFileSync(path, "utf8"));
    const keys = [
      ...CHECK_CODES.map((code) => `check.${code}`),
      ...CHECK_WARNINGS.map((code) => `check.warning.${code}`),
      "check.passed",
      "check.failed",
    ];
    expect([lang, keys.filter((key) => !(key in strings))]).toEqual([lang, []]);
  }
});
