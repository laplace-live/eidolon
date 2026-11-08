import { describe, expect, test } from "bun:test";
import { detectLang } from "./i18n";

describe("detectLang", () => {
  test("a stored choice wins over the browser's languages", () => {
    expect(detectLang("zh-Hans", ["en-US"])).toBe("zh-Hans");
    expect(detectLang("en", ["zh-CN"])).toBe("en");
    expect(detectLang("zh-CN", ["en-US"])).toBe("zh-Hans");
  });

  test("otherwise the first Chinese or English entry, any Chinese as simplified", () => {
    expect(detectLang(null, ["zh-CN", "en"])).toBe("zh-Hans");
    expect(detectLang(null, ["zh-TW"])).toBe("zh-Hans");
    expect(detectLang(null, ["ja-JP", "en-GB", "zh-CN"])).toBe("en");
    expect(detectLang(null, ["ja-JP", "ZH-hans"])).toBe("zh-Hans");
  });

  test("English when nothing matches, or the stored value isn't a language", () => {
    expect(detectLang(null, ["ja-JP"])).toBe("en");
    expect(detectLang("fr", [])).toBe("en");
  });
});
