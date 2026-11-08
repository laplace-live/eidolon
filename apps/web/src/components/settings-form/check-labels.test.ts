import { expect, mock, test } from "bun:test";
import { linguiMacro } from "@/test/lingui-macro";

mock.module("@lingui/core/macro", linguiMacro);
const { verdictMessage, warningMessage } = await import("./check-labels");

test("a verdict says the provider's own sentence, then the code's, then passed or failed", () => {
  const verdict = (provider: string, ok: boolean, code: string) =>
    verdictMessage(provider, { ok, code }).message;
  expect(verdict("soniox", false, "invalid-key")).toMatch(/^Soniox rejected this key/);
  expect(verdict("fish", false, "invalid-key")).toBe("The provider rejected this key.");
  expect(verdict("fish", false, "teapot")).toBe("Check failed");
  expect(verdict("fish", true, "teapot")).toBe("Check passed");
  expect(warningMessage("free-tier")?.message).toMatch(/never bought credits/);
  expect(warningMessage("teapot")).toBeNull();
});
