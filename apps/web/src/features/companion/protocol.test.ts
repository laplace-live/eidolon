import type { Direction } from "@laplace.live/eidolon-sdk/avatar";
import { describe, expect, test } from "vitest";
import {
  appearanceStamp,
  type CompanionCall,
  NO_COMPANION_CALL,
  type ToCompanion,
  toApp,
  toCompanion,
} from "./protocol";

const CHAT = "0b7f5f2e-3c1d-4e8a-9f60-1a2b3c4d5e6f";

const CALL: CompanionCall = { up: true, live: true, hers: true, micOn: false, callable: false };

const DIRECTION: Direction = {
  persona: null,
  mood: ["lazy", "happy"],
  pulse: "shy",
  speaking: true,
  listening: false,
  thinking: false,
  looking: "idle",
  gesture: { name: "nod", seq: 4 },
};

const MESSAGES: readonly ToCompanion[] = [
  { type: "persona", id: "milky-green", stamp: "tml:ab12:2026-11-23T00:00:00.000Z", picture: 0 },
  { type: "persona", id: "milky-green", stamp: "", picture: 3 },
  { type: "call", call: CALL },
  { type: "call", call: NO_COMPANION_CALL },
  { type: "direction", direction: DIRECTION },
  { type: "direction", direction: { ...DIRECTION, persona: "nana", mood: [], pulse: null } },
  { type: "direction", direction: { ...DIRECTION, gesture: null, looking: "away" } },
  { type: "mouth", level: 0.42 },
  { type: "said", persona: "milky-green", chat: CHAT, seq: 7, text: "[开心地] 在呀" },
  {
    type: "voice",
    persona: "milky-green",
    chat: CHAT,
    seq: 8,
    text: "嘿嘿",
    file: "voice-8.mp3",
    state: "playing",
    position: 1.25,
  },
  {
    type: "voice",
    persona: "milky-green",
    chat: CHAT,
    seq: 8,
    text: "",
    file: "voice-8.mp3",
    state: "ended",
    position: 0,
  },
];

describe("toCompanion", () => {
  test("a persona from a main window that sends no picture's version reads as version 0", () => {
    expect(toCompanion({ type: "persona", id: "milky-green", stamp: "" })).toEqual({
      type: "persona",
      id: "milky-green",
      stamp: "",
      picture: 0,
    });
  });

  test("each message type comes back equal", () => {
    for (const message of MESSAGES) expect(toCompanion(message)).toEqual(message);
  });

  test("a message comes back as a copy of what it reads, never the object that came", () => {
    const message = { type: "call", call: CALL, extra: 1 };
    const read = toCompanion(message);
    expect(read).toEqual({ type: "call", call: CALL });
    expect(read).not.toBe(message);
  });

  test("a level is clamped into 0..1, and one that isn't a number is refused", () => {
    expect(toCompanion({ type: "mouth", level: 1.4 })).toEqual({ type: "mouth", level: 1 });
    expect(toCompanion({ type: "mouth", level: -0.2 })).toEqual({ type: "mouth", level: 0 });
    for (const level of [Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, undefined]) {
      expect(toCompanion({ type: "mouth", level })).toBeNull();
    }
  });

  const said = MESSAGES[8] as Extract<ToCompanion, { type: "said" }>;
  const voice = MESSAGES[9] as Extract<ToCompanion, { type: "voice" }>;

  test.each([
    ["an unknown type", { type: "turn" }],
    ["no type", { id: "milky-green", stamp: "" }],
    ["null", null],
    ["a string", "persona"],
    ["an array", [{ type: "mouth", level: 0.5 }]],
    ["a persona id in capitals", { type: "persona", id: "Milky", stamp: "" }],
    ["a persona id with a slash", { type: "persona", id: "a/b", stamp: "" }],
    ["a stamp that isn't a string", { type: "persona", id: "milky-green", stamp: null }],
    ["a stamp far too long", { type: "persona", id: "milky-green", stamp: "x".repeat(513) }],
    ["a picture below 0", { type: "persona", id: "milky-green", stamp: "", picture: -1 }],
    ["a picture of 1.5", { type: "persona", id: "milky-green", stamp: "", picture: 1.5 }],
    ["a call missing a field", { type: "call", call: { up: true, live: true, hers: true } }],
    ["a call with a string for a flag", { type: "call", call: { ...CALL, micOn: "true" } }],
    ["no call", { type: "call" }],
    [
      "a mood of three tags",
      { type: "direction", direction: { ...DIRECTION, mood: ["happy", "shy", "sad"] } },
    ],
    ["a mood no tag names", { type: "direction", direction: { ...DIRECTION, mood: ["giddy"] } }],
    ["a mood that isn't a list", { type: "direction", direction: { ...DIRECTION, mood: "happy" } }],
    ["a pulse no tag names", { type: "direction", direction: { ...DIRECTION, pulse: "giddy" } }],
    ["a persona that is a number", { type: "direction", direction: { ...DIRECTION, persona: 1 } }],
    ["speaking as a string", { type: "direction", direction: { ...DIRECTION, speaking: "yes" } }],
    ["no listening", { type: "direction", direction: { ...DIRECTION, listening: undefined } }],
    ["thinking as a number", { type: "direction", direction: { ...DIRECTION, thinking: 1 } }],
    ["a look elsewhere", { type: "direction", direction: { ...DIRECTION, looking: "down" } }],
    [
      "a gesture wave",
      { type: "direction", direction: { ...DIRECTION, gesture: { name: "wave", seq: 1 } } },
    ],
    [
      "a gesture seq of 1.5",
      { type: "direction", direction: { ...DIRECTION, gesture: { name: "nod", seq: 1.5 } } },
    ],
    [
      "a gesture seq below 0",
      { type: "direction", direction: { ...DIRECTION, gesture: { name: "nod", seq: -1 } } },
    ],
    [
      "a gesture that is a name",
      { type: "direction", direction: { ...DIRECTION, gesture: "nod" } },
    ],
    ["no direction", { type: "direction" }],
    ["a fact's persona id in capitals", { ...said, persona: "Milky" }],
    ["a chat id in capitals", { ...said, chat: CHAT.toUpperCase() }],
    ["a chat id that isn't one", { ...said, chat: "../settings" }],
    ["a seq of 1.5", { ...said, seq: 1.5 }],
    ["a seq of 0", { ...said, seq: 0 }],
    ["a seq that is a string", { ...said, seq: "7" }],
    ["text past 20,000 characters", { ...said, text: "啊".repeat(20_001) }],
    ["text that isn't a string", { ...said, text: null }],
    ["a file of ../a.mp3", { ...voice, file: "../a.mp3" }],
    ["a file of ..", { ...voice, file: ".." }],
    ["a file in a folder", { ...voice, file: "a/b.mp3" }],
    ["a file behind a backslash", { ...voice, file: "a\\b.mp3" }],
    ["an empty file", { ...voice, file: "" }],
    ["a file past 200 characters", { ...voice, file: `${"a".repeat(197)}.mp3` }],
    ["a state no bubble has", { ...voice, state: "stopped" }],
    ["a position below 0", { ...voice, position: -1 }],
    ["a position of NaN", { ...voice, position: Number.NaN }],
    ["a voice fact with no file", { ...voice, file: undefined }],
  ])("refuses %s", (_, message) => {
    expect(toCompanion(message)).toBeNull();
  });
});

describe("toApp", () => {
  test("her appearance comes back equal, a copy", () => {
    const message = { type: "appearance", persona: "milky-green" } as const;
    expect(toApp(message)).toEqual(message);
    expect(toApp({ ...message, extra: true })).toEqual(message);
  });

  test("nothing that would act on the call, and nothing else, is taken", () => {
    for (const message of [
      { type: "call", persona: "milky-green" },
      { type: "hang-up", persona: "milky-green" },
      { type: "mic", on: true, persona: "milky-green" },
      { type: "mic", on: false, persona: "milky-green" },
      { type: "appearance" },
      { type: "appearance", persona: "Milky" },
      { type: "persona", id: "milky-green", stamp: "" },
      null,
      "appearance",
    ]) {
      expect(toApp(message)).toBeNull();
    }
  });
});

describe("appearanceStamp", () => {
  test("her active model's id, file and change time; empty for none", () => {
    expect(appearanceStamp(null)).toBe("");
    expect(
      appearanceStamp({
        id: "tml",
        name: "TML",
        kind: "psd2live",
        sha256: "ab12",
        updatedAt: "2026-11-23T00:00:00.000Z",
      }),
    ).toBe("tml:ab12:2026-11-23T00:00:00.000Z");
  });
});
