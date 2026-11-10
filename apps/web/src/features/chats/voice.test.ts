import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "@eidolon/chat";
import {
  claimPlayback,
  clock,
  knownDuration,
  recordingType,
  releasePlayback,
  voiceReplies,
} from "./voice";

describe("recordingType", () => {
  test("is WebM with Opus where the browser records it, else MP4, else none", () => {
    expect(recordingType(() => true)).toBe("audio/webm;codecs=opus");
    expect(recordingType((type) => type === "audio/mp4")).toBe("audio/mp4");
    expect(recordingType(() => false)).toBeNull();
  });
});

describe("clock", () => {
  test("writes minutes and two-digit seconds, rounded", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(7_400)).toBe("0:07");
    expect(clock(59_600)).toBe("1:00");
    expect(clock(125_000)).toBe("2:05");
    expect(clock(-1)).toBe("0:00");
  });
});

describe("knownDuration", () => {
  test("is null while the element can't tell, as for a recorded WebM", () => {
    expect(knownDuration(Number.NaN)).toBeNull();
    expect(knownDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(knownDuration(0)).toBeNull();
    expect(knownDuration(2.5)).toBe(2500);
  });
});

describe("voiceReplies", () => {
  const audio = { kind: "audio", name: `${"d".repeat(64)}.mp3`, mime: "audio/mpeg" } as const;
  const message = (seq: number, fields: Partial<ChatEvent & { type: "message" }>): ChatEvent => ({
    type: "message",
    seq,
    at: seq,
    id: `m${seq}`,
    speaker: { kind: "persona", id: "mio" },
    text: "嗨",
    ...fields,
  });

  test("are her voice messages with their audio, and nothing else", () => {
    expect(
      voiceReplies([
        message(1, { modality: "voice", attachments: [audio] }),
        message(2, { modality: "voice", attachments: [audio], speaker: { kind: "user" } }),
        message(3, {}),
        message(4, { modality: "voice" }),
        { type: "turn-failed", seq: 5, at: 5, persona: "mio", turn: "t", error: "x" },
        message(6, { modality: "voice", attachments: [audio] }),
      ]),
    ).toEqual([1, 6]);
  });
});

describe("playback", () => {
  test("starting one pauses the one playing, and only that one", () => {
    const paused: string[] = [];
    const audio = (name: string) => ({ pause: () => paused.push(name) });
    const [a, b, c] = [audio("a"), audio("b"), audio("c")];
    claimPlayback(a);
    claimPlayback(a);
    claimPlayback(b);
    releasePlayback(b);
    claimPlayback(c);
    expect(paused).toEqual(["a"]);
    releasePlayback(c);
  });
});
