import "../../config/test/isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, installSettings, resetSettings } from "@eidolon/config";
import {
  alternativeStyleNames,
  createVoiceTool,
  loadVoiceStyles,
  VOICE_TOOL_NAME,
  voicePromptHint,
  voiceToolSchema,
} from "../src/index.ts";
import {
  VOICE_HINT,
  VOICE_HINT_WITHOUT_DEFAULT,
  VOICE_ROWS,
  VOICE_SCHEMA_WIRE,
  VOICE_SCHEMA_WIRE_UNHINTED,
} from "./goldens.ts";
import { captureLogs, invoke, logLines, restoreEnv, restoreLogs, setEnv, wire } from "./helpers.ts";

const STYLES = new Map([
  ["default", "refdefault0000"],
  ["gentle", "refgentle0000"],
]);

afterEach(() => {
  restoreEnv();
  restoreLogs();
});

describe("loadVoiceStyles", () => {
  test("strips, lowercases and skips blanks in environment order, as Python does", () => {
    const styles = loadVoiceStyles({
      FISH_VOICE_ID: "  base  ",
      FISH_VOICE_ID_GENTLE: " g ",
      FISH_VOICE_ID_BLANK: "   ",
      FISH_VOICE_ID_EMPTY: "",
      FISH_VOICE_ID_: "nosuffix",
      FISH_VOICE_ID_NAI_HEI: "nh",
      FISH_VOICE_ID_Gentle: "g2",
      FISH_VOICE_ID_DEFAULT: "override",
      fish_voice_id_lower: "case-sensitive prefix",
      UNRELATED: "x",
    });
    expect([...styles]).toEqual([
      ["default", "override"],
      ["gentle", "g2"],
      ["nai_hei", "nh"],
    ]);
  });

  test("a voice on an account credentials.json adds keeps its styles", () => {
    const credentials = join(dataHome(), "credentials.json");
    mkdirSync(dataHome(), { recursive: true });
    writeFileSync(
      credentials,
      JSON.stringify({ accounts: { "fish-2": { provider: "fish", apiKey: "fk" } } }),
      { mode: 0o600 },
    );
    installSettings();
    try {
      const styles = loadVoiceStyles({
        TTS_PROVIDER: "fish-2",
        TTS_VOICE_ID: "base",
        TTS_VOICE_ID_GENTLE: "g",
      });
      expect([...styles]).toEqual([
        ["default", "base"],
        ["gentle", "g"],
      ]);
    } finally {
      rmSync(credentials, { force: true });
      resetSettings();
    }
  });

  test("an unset or blank FISH_VOICE_ID leaves no default", () => {
    expect([...loadVoiceStyles({ FISH_VOICE_ID_LIVELY: "l" })]).toEqual([["lively", "l"]]);
    expect([...loadVoiceStyles({ FISH_VOICE_ID: " ", FISH_VOICE_ID_LIVELY: "l" })]).toEqual([
      ["lively", "l"],
    ]);
  });

  test("TTS_VOICE_ID_<STYLE> overrides Fish's name for the same style", () => {
    const styles = loadVoiceStyles({
      TTS_VOICE_ID_GENTLE: "t",
      FISH_VOICE_ID: "base",
      FISH_VOICE_ID_GENTLE: "f",
      FISH_VOICE_ID_CALM: "c",
    });
    expect([...styles]).toEqual([
      ["default", "base"],
      ["gentle", "t"],
      ["calm", "c"],
    ]);
  });

  test("Fish's names apply only while Fish speaks", () => {
    const styles = loadVoiceStyles({
      TTS_PROVIDER: "elevenlabs",
      TTS_VOICE_ID: "eleven",
      FISH_VOICE_ID: "fish",
      FISH_VOICE_ID_GENTLE: "f",
      TTS_VOICE_ID_CALM: "c",
    });
    expect([...styles]).toEqual([
      ["default", "eleven"],
      ["calm", "c"],
    ]);
  });

  test("a voice provider Eidolon doesn't know has no styles; the call reports it", () => {
    expect([...loadVoiceStyles({ TTS_PROVIDER: "nope", TTS_VOICE_ID_CALM: "c" })]).toEqual([]);
  });

  test("reads process.env by default", () => {
    setEnv("FISH_VOICE_ID_EIDOLONTEST", " ref ");
    expect(loadVoiceStyles().get("eidolontest")).toBe("ref");
  });
});

describe("voiceToolSchema", () => {
  test("serializes exactly as Python's schema does", () => {
    const styles = new Map([
      ["default", "a"],
      ["gentle", "b"],
      ["lively", "c"],
      ["nai_hei", "d"],
    ]);
    expect(wire(voiceToolSchema(styles))).toBe(VOICE_SCHEMA_WIRE);
  });

  test("a style without a hint shows its own name; the enum sorts by code point", () => {
    const styles = new Map([
      ["calm", "a"],
      ["default", "b"],
      ["constructor", "c"],
      ["Z", "d"],
    ]);
    expect(wire(voiceToolSchema(styles))).toBe(VOICE_SCHEMA_WIRE_UNHINTED);
  });
});

describe("createVoiceTool", () => {
  test("offers nothing when only default is configured", () => {
    const records = captureLogs();
    expect(createVoiceTool(new Map([["default", "a"]]))).toBeNull();
    expect(createVoiceTool(new Map())).toBeNull();
    expect(logLines(records)).toEqual([
      "INFO [voice] Voice switching disabled (no TTS_VOICE_ID_<STYLE> voices set).",
      "INFO [voice] Voice switching disabled (no TTS_VOICE_ID_<STYLE> voices set).",
    ]);
  });

  test("is a synchronous tool with no timeout of its own", () => {
    const records = captureLogs();
    const tool = createVoiceTool(
      new Map([
        ["default", "a"],
        ["lively", "c"],
        ["gentle", "b"],
      ]),
    );
    expect(tool?.schema.name).toBe(VOICE_TOOL_NAME);
    expect(tool?.cancelOnInterruption).toBe(true);
    expect(tool?.timeoutSecs).toBeNull();
    expect(logLines(records)).toEqual([
      "INFO [voice] Voice switching enabled. Default='default', alternatives=['gentle', 'lively'].",
    ]);
  });

  test("lists alternatives without default, sorted", () => {
    expect(
      alternativeStyleNames(
        new Map([
          ["b", "1"],
          ["default", "2"],
          ["A", "3"],
        ]),
      ),
    ).toEqual(["A", "b"]);
  });
});

describe("change_voice_style", () => {
  test("every probed call matches Python's frames and results, in order", async () => {
    captureLogs();
    const tool = createVoiceTool(STYLES);
    if (!tool) throw new Error("tool expected");
    for (const [args, expected] of VOICE_ROWS) {
      const { events } = await invoke(tool, args);
      expect([args, events]).toEqual([args, expected]);
    }
  });

  test("logs as Python does", async () => {
    const records = captureLogs();
    const tool = createVoiceTool(STYLES);
    if (!tool) throw new Error("tool expected");
    records.length = 0;
    await invoke(tool, { style: " Gentle " });
    await invoke(tool, { style: "it's" });
    await invoke(tool, {});
    expect(logLines(records)).toEqual([
      "INFO [voice] Switching style → 'gentle' (reference_id=refgentl…)",
      `WARNING [voice] LLM requested unknown style "it's"; configured: ['default', 'gentle']`,
      "WARNING [voice] LLM requested unknown style None; configured: ['default', 'gentle']",
    ]);
  });

  test("switching to the active style still switches", async () => {
    captureLogs();
    const tool = createVoiceTool(STYLES);
    if (!tool) throw new Error("tool expected");
    const first = await invoke(tool, { style: "gentle" });
    const second = await invoke(tool, { style: "gentle" });
    expect(second.events).toEqual(first.events);
  });
});

describe("voicePromptHint", () => {
  test("is empty without alternatives", () => {
    expect(voicePromptHint(new Map([["default", "a"]]))).toBe("");
    expect(voicePromptHint(new Map())).toBe("");
  });

  test("matches Python, listing default first even when it isn't configured", () => {
    const styles = new Map([
      ["default", "a"],
      ["gentle", "b"],
      ["lively", "c"],
      ["nai_hei", "d"],
    ]);
    expect(voicePromptHint(styles)).toBe(VOICE_HINT);
    expect(
      voicePromptHint(
        new Map([
          ["gentle", "b"],
          ["calm", "c"],
        ]),
      ),
    ).toBe(VOICE_HINT_WITHOUT_DEFAULT);
  });
});
