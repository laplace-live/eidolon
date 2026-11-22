import { expect, test, vi } from "vitest";
import { linguiMacro } from "@/test/lingui-macro";
import { ERROR_CODES } from "../../../bot/src/local/api.ts";
import { ApiError, CLIENT_ERROR_CODES } from "./api";

vi.doMock("@lingui/core/macro", linguiMacro);
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

test("in the desktop app, a sentence that sends you to a terminal says what to do there", () => {
  const message = (error: unknown) => errorMessage(error).message;
  const bridge = { version: "0.1.0", serverVersion: "0.13.0" };
  const ignore = () => {};
  const sentences = (platform: string) => {
    globalThis.eidolonDesktop = {
      ...bridge,
      platform,
      setTheme: ignore,
      setLanguage: ignore,
      onCommand: ignore,
    };
    return [
      message(new ApiError(500, "internal", "")),
      message(new ApiError(0, "unreachable", "")),
      message(new ApiError(401, "unauthorized", "")),
      message(new ApiError(401, "proof-missing", "")),
      message(new ApiError(409, "call-active", "")),
    ];
  };
  try {
    expect(sentences("darwin")).toEqual([
      "Eidolon hit an internal error. Show Logs in the Help menu has the details.",
      "Can't reach Eidolon's server. If it doesn't come back, quit Eidolon and open it again.",
      "This window isn't signed in. Quit Eidolon and open it again.",
      "This window isn't signed in. Quit Eidolon and open it again.",
      "A call is in progress. Hang up first.",
    ]);
    expect(sentences("win32")[0]).toBe(
      "Eidolon hit an internal error. Show Logs in the tray icon's menu has the details.",
    );
  } finally {
    globalThis.eidolonDesktop = undefined;
  }
  expect(message(new ApiError(500, "internal", ""))).toBe(
    "Eidolon hit an internal error. The terminal has the details.",
  );
});

test("a list is joined as the language joins one", () => {
  expect(listOf(["Chat", "Memory"])).toBe("Chat, Memory");
});
