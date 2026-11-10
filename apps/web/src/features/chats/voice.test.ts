import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "@eidolon/chat";
import {
  afterAutoPlay,
  cancelsTake,
  claimPlayback,
  knownDuration,
  MicRequests,
  pausePlayback,
  playsNextAfter,
  queueReplies,
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

describe("MicRequests", () => {
  test("one at a time: a start while one is under way asks for nothing", () => {
    const requests = new MicRequests();
    const first = requests.begin();
    expect(first).not.toBeNull();
    expect(requests.begin()).toBeNull();
    expect(requests.settle(first as number)).toBe(true);
    expect(requests.begin()).not.toBeNull();
  });

  test("a cancelled request's late answer is let go, and leaves the next one under way", () => {
    const requests = new MicRequests();
    const cancelled = requests.begin() as number;
    requests.cancel();
    const again = requests.begin() as number;
    // The cancelled request is refused before the new one is granted.
    expect(requests.settle(cancelled)).toBe(false);
    expect(requests.begin()).toBeNull();
    expect(requests.settle(again)).toBe(true);
    expect(requests.settle(again)).toBe(false);
  });
});

describe("cancelsTake", () => {
  test("Escape throws the take away, unless a menu or sheet took it to close itself", () => {
    expect(cancelsTake({ key: "Escape", defaultPrevented: false })).toBe(true);
    expect(cancelsTake({ key: "Escape", defaultPrevented: true })).toBe(false);
    expect(cancelsTake({ key: "Enter", defaultPrevented: false })).toBe(false);
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

describe("queueReplies", () => {
  test("her new replies wait their turn to play while the tab has the focus", () => {
    expect(queueReplies([3], [5, 7], { focused: true, calling: false })).toEqual([3, 5, 7]);
    expect(queueReplies([3], [5], { focused: false, calling: false })).toEqual([3]);
  });

  test("none waits while a call is on, whose microphone would hear them", () => {
    expect(queueReplies([3], [5], { focused: true, calling: true })).toEqual([]);
  });
});

describe("afterAutoPlay", () => {
  test("the next reply plays on its own only while the tab still has the focus", () => {
    expect(afterAutoPlay([3, 5, 7], true, true)).toEqual([5, 7]);
    expect(afterAutoPlay([3, 5, 7], true, false)).toEqual([]);
  });

  test("one paused, or refused by the browser, ends them all", () => {
    expect(afterAutoPlay([3, 5], false, true)).toEqual([]);
  });
});

describe("playsNextAfter", () => {
  test("played through, the next plays; paused, none does; the pause before the end, it plays on", () => {
    expect(playsNextAfter("ended", true)).toBe(true);
    expect(playsNextAfter("pause", false)).toBe(false);
    expect(playsNextAfter("pause", true)).toBeNull();
    expect(playsNextAfter("timeupdate", false)).toBeNull();
  });

  test("a clip that breaks off, lost or undecodable, is passed over for the next", () => {
    expect(playsNextAfter("error", false)).toBe(true);
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

  test("a call starting pauses the one playing, and nothing once none plays", () => {
    const paused: string[] = [];
    const audio = { pause: () => paused.push("a") };
    pausePlayback();
    claimPlayback(audio);
    pausePlayback();
    expect(paused).toEqual(["a"]);
    // The bubble lets go of it as its pause event arrives.
    releasePlayback(audio);
    pausePlayback();
    expect(paused).toEqual(["a"]);
  });
});
