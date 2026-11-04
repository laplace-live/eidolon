import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AUDIO_QUALITIES,
  type AudioQualitySettings,
  audioQualitySettingsFromEnv,
  describeOpusBitrates,
  qualityChoices,
  resolveQualityBitrate,
  sessionBitrateFor,
} from "../src/index.ts";
import { EnvPatch, LogCapture } from "./helpers.ts";

const DEFAULTS: AudioQualitySettings = {
  presetsBps: { best: 192000, medium: 96000, low: 64000, lowest: 8000 },
  defaultBitrateBps: 96000,
};

const OPUS_VARS = [
  "EIDOLON_OPUS_BITRATE_BEST_BPS",
  "EIDOLON_OPUS_BITRATE_MEDIUM_BPS",
  "EIDOLON_OPUS_BITRATE_LOW_BPS",
  "EIDOLON_OPUS_BITRATE_LOWEST_BPS",
  "EIDOLON_OPUS_BITRATE_BPS",
];

let logs: LogCapture;
const env = new EnvPatch();
beforeEach(() => {
  logs = new LogCapture();
  for (const name of OPUS_VARS) env.set(name, undefined);
});
afterEach(() => {
  logs.restore();
  env.restore();
});

const unknown = (repr: string) =>
  `WARNING|[offer-middleware] Unknown audioQuality=${repr}; valid choices: ` +
  "['best', 'medium', 'low', 'lowest']. Falling back to default 96 kbps.";
const chosen = (name: string, kbps: number) =>
  `INFO|[offer-middleware] audioQuality='${name}' → Opus bitrate ${kbps} kbps for this session`;

describe("sessionBitrateFor", () => {
  // Each row is what Python's _apply_session_audio_quality set and logged.
  const rows: [string, unknown, number, string[]][] = [
    ["absent", undefined, 96000, []],
    ["null", null, 96000, []],
    ["empty", "", 96000, []],
    ["blank", "  ", 96000, []],
    ["best", "best", 192000, [chosen("best", 192)]],
    ["padded upper case", " BEST ", 192000, [chosen("best", 192)]],
    ["mixed case", "Medium", 96000, [chosen("medium", 96)]],
    ["low", "low", 64000, [chosen("low", 64)]],
    ["a trailing newline", "low\n", 64000, [chosen("low", 64)]],
    ["lowest", "lowest", 8000, [chosen("lowest", 8)]],
    ["a leading space", " low", 64000, [chosen("low", 64)]],
    ["Python strips \\x1c", "best\x1c", 192000, [chosen("best", 192)]],
    ["an unknown name", "high", 96000, [unknown("'high'")]],
    ["an integer", 192000, 96000, [unknown("192000")]],
    ["a boolean", true, 96000, [unknown("True")]],
    ["a list", ["low"], 96000, [unknown("['low']")]],
    ["an object", { a: 1 }, 96000, [unknown("{'a': 1}")]],
    ["a float", 1.5, 96000, [unknown("1.5")]],
    ["an Object.prototype name", "constructor", 96000, [unknown("'constructor'")]],
  ];

  test.each(rows)("%s", (_name, raw, bitrate, lines) => {
    expect(sessionBitrateFor(raw, DEFAULTS)).toBe(bitrate);
    expect(logs.lines()).toEqual(lines);
  });

  test("the default is whatever the settings say", () => {
    const settings = { ...DEFAULTS, defaultBitrateBps: 48000 };
    expect(sessionBitrateFor(undefined, settings)).toBe(48000);
    expect(sessionBitrateFor("nope", settings)).toBe(48000);
    expect(logs.lines()[0]).toEndWith("Falling back to default 48 kbps.");
  });

  test("a preset configured to 0 is used as is", () => {
    const settings = { ...DEFAULTS, presetsBps: { ...DEFAULTS.presetsBps, low: 0 } };
    expect(sessionBitrateFor("low", settings)).toBe(0);
    expect(logs.lines()).toEqual([chosen("low", 0)]);
  });
});

describe("resolveQualityBitrate", () => {
  test("only preset names resolve", () => {
    expect(resolveQualityBitrate(" LOWEST ", DEFAULTS)).toBe(8000);
    for (const raw of ["", "toString", "__proto__", 64000, null, undefined, ["best"]]) {
      expect(resolveQualityBitrate(raw, DEFAULTS)).toBeNull();
    }
  });
});

describe("settings", () => {
  test("defaults", () => {
    expect(audioQualitySettingsFromEnv()).toEqual(DEFAULTS);
  });

  test("a medium override moves the default with it", () => {
    env.set("EIDOLON_OPUS_BITRATE_MEDIUM_BPS", "128000");
    const settings = audioQualitySettingsFromEnv();
    expect(settings.presetsBps.medium).toBe(128000);
    expect(settings.defaultBitrateBps).toBe(128000);
  });

  test("EIDOLON_OPUS_BITRATE_BPS wins over the medium preset", () => {
    env.set("EIDOLON_OPUS_BITRATE_MEDIUM_BPS", "128000").set("EIDOLON_OPUS_BITRATE_BPS", "64000");
    expect(audioQualitySettingsFromEnv().defaultBitrateBps).toBe(64000);
  });

  test("every preset reads its own var, unclamped", () => {
    env
      .set("EIDOLON_OPUS_BITRATE_BEST_BPS", "256000")
      .set("EIDOLON_OPUS_BITRATE_LOW_BPS", "-1")
      .set("EIDOLON_OPUS_BITRATE_LOWEST_BPS", "")
      .set("EIDOLON_OPUS_BITRATE_BPS", "garbage");
    expect(audioQualitySettingsFromEnv()).toEqual({
      presetsBps: { best: 256000, medium: 96000, low: -1, lowest: 8000 },
      defaultBitrateBps: 96000,
    });
    expect(logs.lines()).toHaveLength(1);
    expect(logs.lines()[0]).toStartWith("WARNING|EIDOLON_OPUS_BITRATE_BPS=");
  });

  test("qualityChoices is best to lowest and a fresh copy", () => {
    const choices = qualityChoices();
    expect(choices).toEqual(["best", "medium", "low", "lowest"]);
    choices.pop();
    expect(qualityChoices()).toEqual([...AUDIO_QUALITIES]);
  });
});

describe("describeOpusBitrates", () => {
  test("the line bot.py logged at boot", () => {
    expect(describeOpusBitrates(DEFAULTS)).toBe(
      "[WebRTC] Opus encoder bitrate: default 96 kbps, presets best=192kbps, medium=96kbps, " +
        "low=64kbps, lowest=8kbps",
    );
  });

  test("kbps is Python floor division", () => {
    const settings: AudioQualitySettings = {
      presetsBps: { best: 192999, medium: 1500, low: 999, lowest: -1 },
      defaultBitrateBps: 128500,
    };
    expect(describeOpusBitrates(settings)).toBe(
      "[WebRTC] Opus encoder bitrate: default 128 kbps, presets best=192kbps, medium=1kbps, " +
        "low=0kbps, lowest=-1kbps",
    );
  });
});
