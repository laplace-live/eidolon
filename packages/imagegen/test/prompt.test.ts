import { afterEach, describe, expect, test } from "bun:test";
import {
  AFTER_DARK,
  AMBIENCE,
  ambience,
  buildSelfiePrompt,
  fillTime,
  INDOORS,
  OUTDOORS,
  personaClock,
  SELFIE_PROMPT,
} from "../src/index.ts";
import {
  AMBIENCE_LABELS,
  AMBIENCE_ROWS,
  FILL_TIME_07,
  INDOORS_TEXT,
  OUTDOORS_TEXT,
  PROMPT_DUPLICATES_0000,
  PROMPT_GROUP_2230,
  PROMPT_SOLO_0905,
  SELFIE_PROMPT_TEXT,
} from "./goldens.ts";
import { captureLogs, restoreEnv, restoreLogs, setEnv } from "./helpers.ts";

afterEach(() => {
  restoreEnv();
  restoreLogs();
});

describe("prompt texts", () => {
  test("match the Python constants byte for byte", () => {
    expect(SELFIE_PROMPT).toBe(SELFIE_PROMPT_TEXT);
    expect(INDOORS).toBe(INDOORS_TEXT);
    expect(OUTDOORS).toBe(OUTDOORS_TEXT);
    expect(AMBIENCE.map((row) => [row.start, row.label, row.indoor, row.outdoor])).toEqual(
      AMBIENCE_ROWS,
    );
  });
});

describe("ambience", () => {
  test("maps every hour as Python does, wrapping early hours to the last row", () => {
    for (let hour = 0; hour < 24; hour++) {
      expect(ambience(hour).label).toBe(AMBIENCE_LABELS[String(hour)] as string);
    }
  });

  test("after dark means the night and late-night rows", () => {
    expect([...AFTER_DARK].sort()).toEqual(["late night", "night"]);
  });
});

describe("fillTime", () => {
  test("fills every slot occurrence at every hour, indoors and out", () => {
    for (let hour = 0; hour < 24; hour++) {
      const clock = { hour, minute: 7 };
      const [indoor, outdoor] = FILL_TIME_07[String(hour)] as [string, string];
      expect(fillTime("{time}|{light}|{x}{time}", { clock })).toBe(indoor);
      expect(fillTime("{time}|{light}", { outdoors: true, clock })).toBe(outdoor);
    }
  });

  test("zero-pads the 24-hour clock", () => {
    expect(fillTime("{time}", { clock: { hour: 9, minute: 5 } })).toBe(
      "mid-morning, about 09:05 local time",
    );
    expect(fillTime("{time}", { clock: { hour: 0, minute: 0 } })).toBe(
      "late night, about 00:00 local time",
    );
  });

  test("reads the persona clock when none is given", () => {
    setEnv("PERSONA_TIMEZONE", "UTC");
    const label = (c: { hour: number; minute: number }) => fillTime("{time}", { clock: c });
    const before = label(personaClock());
    const filled = fillTime("{time}");
    const after = label(personaClock());
    expect([before, after]).toContain(filled);
  });
});

describe("buildSelfiePrompt", () => {
  test("solo at 09:05 matches Python", () => {
    expect(buildSelfiePrompt([], { hour: 9, minute: 5 })).toBe(PROMPT_SOLO_0905);
  });

  test("with a friend at 22:30 matches Python", () => {
    expect(buildSelfiePrompt(["七海Nana7mi"], { hour: 22, minute: 30 })).toBe(PROMPT_GROUP_2230);
  });

  test("keeps duplicate names and counts each", () => {
    const prompt = buildSelfiePrompt(["A", "A"], { hour: 0, minute: 0 });
    expect(prompt).toBe(PROMPT_DUPLICATES_0000);
    expect(prompt).toContain("Also in frame: A, A. Exactly 3 people");
  });

  test("a name carrying replacement patterns stays literal", () => {
    const prompt = buildSelfiePrompt(["A$&B$'C$$"], { hour: 12, minute: 0 });
    expect(prompt).toContain("Also in frame: A$&B$'C$$. Exactly 2 people");
  });
});

describe("personaClock", () => {
  const instant = new Date("2026-11-03T01:05:00Z");

  test("defaults to Asia/Shanghai, blank included", () => {
    setEnv("PERSONA_TIMEZONE", undefined);
    expect(personaClock(instant)).toMatchObject({ hour: 9, minute: 5 });
    setEnv("PERSONA_TIMEZONE", "");
    expect(personaClock(instant)).toMatchObject({ hour: 9, minute: 5 });
  });

  test("an unknown zone falls back to UTC", () => {
    captureLogs();
    setEnv("PERSONA_TIMEZONE", "Not/AZone");
    expect(personaClock(instant)).toMatchObject({ hour: 1, minute: 5 });
  });

  test("follows daylight saving time", () => {
    setEnv("PERSONA_TIMEZONE", "America/Los_Angeles");
    expect(personaClock(new Date("2026-03-08T09:59:00Z"))).toMatchObject({ hour: 1, minute: 59 });
    expect(personaClock(new Date("2026-03-08T10:00:00Z"))).toMatchObject({ hour: 3, minute: 0 });
  });
});
