import { expect, test } from "bun:test";
import { PROVIDERS } from "../../lib/providers";
import { checkTone, keyPages } from "./credentials";

test("a provider's key and billing pages are https, and a provider without either has none", () => {
  for (const provider of PROVIDERS) {
    const pages = keyPages(provider.id);
    for (const page of [pages?.key, pages?.credit]) {
      if (page) expect(new URL(page).protocol).toBe("https:");
    }
  }
  expect(keyPages("ollama")).toBeUndefined();
});

test("checkTone", () => {
  expect(checkTone({ ok: false, warnings: [] })).toBe("error");
  expect(checkTone({ ok: true, warnings: [{ code: "free-tier", message: "" }] })).toBe("warn");
  expect(checkTone({ ok: true, warnings: [] })).toBe("ok");
});
