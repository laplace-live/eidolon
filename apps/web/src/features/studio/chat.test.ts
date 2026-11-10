import { expect, test } from "bun:test";
import { DEFAULT_CHAT_TALKATIVENESS } from "@eidolon/config";
import { DEFAULT_TALKATIVENESS, talkativenessOf } from "./chat";

test("the slider's default is the bot's", () => {
  expect(DEFAULT_TALKATIVENESS).toBe(DEFAULT_CHAT_TALKATIVENESS);
});

test("talkativeness is the draft's, else the environment's, else the default", () => {
  expect(talkativenessOf("0.8", "0.2")).toBe(0.8);
  expect(talkativenessOf("", "0.2")).toBe(0.2);
  expect(talkativenessOf("  ", null)).toBe(DEFAULT_TALKATIVENESS);
  // A full-width digit, as a Chinese input method types it.
  expect(talkativenessOf("０.３", null)).toBe(0.3);
});

test("it is clamped to 0–1, and a value that isn't a number counts as unset", () => {
  expect(talkativenessOf("1.5", null)).toBe(1);
  expect(talkativenessOf("-1", null)).toBe(0);
  expect(talkativenessOf("lots", "0.9")).toBe(0.9);
  expect(talkativenessOf("lots", "much")).toBe(DEFAULT_TALKATIVENESS);
});
