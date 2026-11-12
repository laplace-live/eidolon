import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "@eidolon/chat";
import {
  EMPTY_TRANSCRIPT,
  reduceTranscript,
  type Transcript,
  type TranscriptEvent,
} from "@/features/call/transcript";
import { callRows, ongoingCall, standsIn } from "./call-live";
import { type ChatItem, chatItems } from "./items";

const said = (text: string, final = true): TranscriptEvent => ({
  type: "user-input",
  data: { text, input_type: "transcription", final },
});

const announce = (segment_id: number, text: string): TranscriptEvent => ({
  type: "bot-output",
  data: {
    text,
    segment_id,
    output_type: "sentence",
    spoken: false,
    will_be_spoken: true,
    spoken_status: "new",
    spoken_progress: { accumulated_text: "", remaining_text: text },
  },
});

const speaking = (persona: string, name: string): TranscriptEvent => ({
  type: "speaker",
  speaker: { persona, name },
});

function transcript(...events: TranscriptEvent[]): Transcript {
  return events.reduce(reduceTranscript, EMPTY_TRANSCRIPT);
}

// Each event is stamped a second after the one before it.
const line = (seq: number, speaker: "user" | string, text: string): ChatEvent => ({
  type: "message",
  seq,
  at: seq * 1000,
  id: `m${seq}`,
  speaker: speaker === "user" ? { kind: "user" } : { kind: "persona", id: speaker },
  text,
  modality: "call",
});

const BEFORE: ChatEvent[] = [
  { type: "message", seq: 1, at: 1000, id: "m1", speaker: { kind: "user" }, text: "在吗" },
  {
    type: "message",
    seq: 2,
    at: 2000,
    id: "m2",
    speaker: { kind: "persona", id: "mio" },
    text: "在呀",
  },
];

describe("ongoingCall", () => {
  test("is the page's call, from its start until its end is stored", () => {
    const begun: ChatEvent = { type: "call-started", seq: 3, at: 3000, call: "c1", persona: "mio" };
    expect(ongoingCall(BEFORE, "c1")).toBeNull();
    expect(ongoingCall([...BEFORE, begun], "c1")).toBe(3);
    expect(ongoingCall([...BEFORE, begun, line(4, "user", "你好")], "c1")).toBe(3);
    const ended: ChatEvent = { type: "call-ended", seq: 5, at: 5000, call: "c1", reason: "hangup" };
    expect(ongoingCall([...BEFORE, begun, line(4, "user", "你好"), ended], "c1")).toBeNull();
  });

  test("never a call before it, though the page placed its own before its log held that one", () => {
    const earlier: ChatEvent[] = [
      { type: "call-started", seq: 3, at: 3000, call: "old", persona: "mio" },
      { type: "call-ended", seq: 4, at: 4000, call: "old", reason: "hangup" },
    ];
    expect(ongoingCall([...BEFORE, ...earlier], "c1")).toBeNull();
    expect(
      ongoingCall(
        [
          ...BEFORE,
          ...earlier,
          { type: "call-started", seq: 5, at: 5000, call: "c1", persona: "mio" },
        ],
        "c1",
      ),
    ).toBe(5);
  });

  test("a reply the call stopped, stored before its start, is no start", () => {
    const events: ChatEvent[] = [
      ...BEFORE,
      { ...line(3, "mio", "我正说着"), interrupted: true } as ChatEvent,
      { type: "call-started", seq: 4, at: 4000, call: "c1", persona: "mio" },
    ];
    expect(ongoingCall(events, "c1")).toBe(4);
  });

  test("a call the server lost is over once another call or the viewer's own line is stored", () => {
    const begun: ChatEvent = { type: "call-started", seq: 3, at: 3000, call: "c1", persona: "mio" };
    const text: ChatEvent = { ...line(5, "user", "还在吗"), modality: "text" } as ChatEvent;
    expect(ongoingCall([...BEFORE, begun, line(4, "user", "你好"), text], "c1")).toBeNull();
    expect(
      ongoingCall(
        [...BEFORE, begun, { type: "call-started", seq: 4, at: 4000, call: "c2", persona: "mio" }],
        "c1",
      ),
    ).toBeNull();
    // Her photo from a reply the call stopped lands after its start, and the call goes on.
    const photo: ChatEvent = { ...line(4, "mio", ""), modality: "text" } as ChatEvent;
    expect(ongoingCall([...BEFORE, begun, photo], "c1")).toBe(3);
  });
});

describe("standsIn", () => {
  test("only the call's own lines after its start", () => {
    const items = chatItems([
      ...BEFORE,
      { type: "call-started", seq: 3, at: 3, call: "c1", persona: "mio" },
      line(4, "user", "你好"),
      line(5, "mio", "你好呀"),
      {
        type: "message",
        seq: 6,
        at: 6,
        id: "m6",
        speaker: { kind: "persona", id: "mio" },
        text: "",
        attachments: [{ kind: "image", name: `${"a".repeat(64)}.png`, mime: "image/png" }],
      },
    ]);
    expect(items.filter((item) => !standsIn(item, 3)).map((item) => item.seq)).toEqual([
      1, 2, 3, 6,
    ]);
  });
});

describe("callRows", () => {
  const callStart: ChatItem = {
    kind: "call",
    seq: 3,
    edge: "started",
    persona: "mio",
    durationMs: null,
  };

  test("a call with her alone: the viewer's words as heard, then her reply as hers", () => {
    const rows = callRows(
      transcript(said("你好"), said("在吗", false), announce(1, "在呀。")),
      "mio",
      callStart,
    );
    expect(rows.map((row) => [row.kind, row.kind === "viewer" ? null : row.persona])).toEqual([
      ["viewer", null],
      ["her", "mio"],
    ]);
    expect(rows[1]).toMatchObject({ first: true });
  });

  test("a group call names whoever the server said speaks, and runs her photo on with her", () => {
    const rows = callRows(
      transcript(
        said("你们好"),
        speaking("mint", "薄荷"),
        announce(1, "我先说。"),
        { type: "selfie", paths: ["/api/selfie/a.png"], persona: "mint" },
        speaking("mio", "奶绿"),
        announce(2, "轮到我了。"),
      ),
      "mio",
      callStart,
    );
    expect(
      rows.map((row) => (row.kind === "viewer" ? "you" : `${row.persona}${row.first ? "*" : ""}`)),
    ).toEqual(["you", "mint*", "mint", "mio*"]);
  });

  test("her first reply continues her run when she spoke last above it", () => {
    const [row] = callRows(transcript(announce(1, "还有。")), "mio", chatItems(BEFORE)[1]);
    expect(row).toMatchObject({ kind: "her", first: false });
  });
});
