import { describe, expect, test } from "bun:test";
import { buildCatalogs, detectLang, format, placeholders, translate } from "./i18n";

describe("detectLang", () => {
  test("a stored choice wins", () => {
    expect(detectLang("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(detectLang("en", ["zh-CN"])).toBe("en");
  });

  test("otherwise the first Chinese or English preference, any Chinese as Simplified", () => {
    expect(detectLang(null, ["zh-CN", "en"])).toBe("zh-CN");
    expect(detectLang(null, ["zh-TW"])).toBe("zh-CN");
    expect(detectLang(null, ["ja-JP", "en-GB", "zh-CN"])).toBe("en");
    expect(detectLang(null, ["ja-JP", "ZH-hans"])).toBe("zh-CN");
  });

  test("English when nothing matches, and an unknown stored value is ignored", () => {
    expect(detectLang(null, [])).toBe("en");
    expect(detectLang(null, ["fr-FR"])).toBe("en");
    expect(detectLang("zh-cn", ["fr-FR"])).toBe("en");
  });
});

describe("buildCatalogs", () => {
  test("keys each string by its file's name", () => {
    expect(
      buildCatalogs({
        "./en/common.json": { "nav.home": "Home" },
        "./en/settings.json": { "embeddings.model": "Embedding model" },
        "./zh-CN/common.json": { "nav.home": "首页" },
      }),
    ).toEqual({
      en: { "common.nav.home": "Home", "settings.embeddings.model": "Embedding model" },
      "zh-CN": { "common.nav.home": "首页" },
    });
  });

  test("refuses a file outside a language folder, or one that isn't a flat string map", () => {
    expect(() => buildCatalogs({ "./zh-cn/common.json": {} })).toThrow("known language");
    expect(() => buildCatalogs({ "./en/common.json": ["a"] })).toThrow("JSON object");
    expect(() => buildCatalogs({ "./en/common.json": { nav: { home: "Home" } } })).toThrow(
      '"nav" is not a string',
    );
  });
});

describe("translate", () => {
  const catalogs = {
    en: { "a.hello": "Hello, {name}", "a.only": "English only" },
    "zh-CN": { "a.hello": "你好，{name}" },
  };

  test("fills placeholders in the chosen language", () => {
    expect(translate(catalogs, "zh-CN", "a.hello", { name: "奶绿" })).toBe("你好，奶绿");
  });

  test("falls back to English, then to the key", () => {
    expect(translate(catalogs, "zh-CN", "a.only")).toBe("English only");
    expect(translate(catalogs, "zh-CN", "a.missing")).toBe("a.missing");
  });
});

test("format leaves a placeholder without a value as written", () => {
  expect(format("{count} of {total}", { count: 3 })).toBe("3 of {total}");
  expect(format("{count} items")).toBe("{count} items");
});

test("placeholders are sorted and unique", () => {
  expect(placeholders("{b} {a} {b} {not a placeholder}")).toEqual(["a", "b"]);
});
