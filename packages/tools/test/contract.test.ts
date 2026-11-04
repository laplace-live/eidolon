import { expect, test } from "bun:test";
import type { LlmTool } from "@eidolon/core";
import * as tools from "../src/index.ts";

// The signatures runtime compiles against; this file stops type-checking if one drifts.
const contract: {
  VOICE_TOOL_NAME: "change_voice_style";
  SELFIE_TOOL_NAME: "take_selfie";
  loadVoiceStyles: () => Map<string, string>;
  createVoiceTool: (styles: ReadonlyMap<string, string>) => LlmTool | null;
  voicePromptHint: (styles: ReadonlyMap<string, string>) => string;
  createSelfieTool: () => LlmTool | null;
  selfiePromptHint: () => string;
} = tools;

test("the pinned exports are live", () => {
  expect(contract.VOICE_TOOL_NAME).toBe("change_voice_style");
  expect(contract.SELFIE_TOOL_NAME).toBe("take_selfie");
  expect(contract.voicePromptHint(new Map())).toBe("");
});
