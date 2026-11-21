import { expect, test } from "vitest";
import { withoutAccounts } from "./use-account-keys";

test("saving some accounts keeps what was typed for the others", () => {
  expect(withoutAccounts({ openai: "sk-1", fish: "k", soniox: "s" }, ["fish", "soniox"])).toEqual({
    openai: "sk-1",
  });
});
