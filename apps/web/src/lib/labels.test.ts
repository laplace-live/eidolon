import { expect, mock, test } from "bun:test";
import { linguiMacro } from "@/test/lingui-macro";
import { ERROR_CODES } from "../../../bot/src/local/api.ts";
import { ApiError, CLIENT_ERROR_CODES } from "./api";

mock.module("@lingui/core/macro", linguiMacro);
const { errorMessage, listOf } = await import("./labels");

test("an error says its code's sentence, and anything else a general one", () => {
  const message = (error: unknown) => errorMessage(error).message;
  expect(message(new ApiError(409, "call-active", "a call is live"))).toBe(
    "A call is in progress. Hang up first.",
  );
  expect(message(new TypeError("x"))).toBe("Something went wrong.");
  for (const code of [...ERROR_CODES, ...CLIENT_ERROR_CODES]) {
    expect(message(new ApiError(400, code, "")), code).not.toBe("Something went wrong.");
  }
});

test("a list is joined as the language joins one", () => {
  expect(listOf(["Chat", "Memory"])).toBe("Chat, Memory");
});
