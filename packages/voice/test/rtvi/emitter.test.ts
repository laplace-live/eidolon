import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { RtviMessage } from "../../src/rtvi/codec.ts";
import { RtviEmitter } from "../../src/rtvi/emitter.ts";
import type { Tag } from "../../src/types.ts";

const ABOUT = { library: "laplace-eidolon", library_version: "0.6.0" };

let sent: RtviMessage[];
let rtvi: RtviEmitter;
beforeEach(() => {
  sent = [];
  rtvi = new RtviEmitter((message) => sent.push(message), ABOUT);
  setSystemTime(new Date("2026-11-09T00:41:18.588Z"));
});
afterEach(() => setSystemTime());

const types = () => sent.map((m) => m.type);
const wire = () => sent.map((m) => JSON.stringify(m));
const tag = (seg: number, reply = "r1", persona = "milky-green"): Tag => ({ reply, persona, seg });

describe("RtviEmitter", () => {
  // The bytes production sent on 2026-11-09 (.cache/eidolon-port/e2e-prod-after-pr25.json).
  test("bot-ready is byte for byte what pipedog sends, echoing the client's id", () => {
    rtvi.botReady("c1");
    expect(wire()).toEqual([
      '{"label":"rtvi-ai","type":"bot-ready","id":"c1","data":{"version":"2.2.0",' +
        '"about":{"library":"laplace-eidolon","library_version":"0.6.0"},' +
        '"capabilities":{"audio_in":true,"audio_out":true,"video_in":false,"screen_in":false,' +
        '"video_out":false,"metrics":true}}}',
    ]);
  });

  test("signals carry no data", () => {
    rtvi.userStartedSpeaking();
    rtvi.botInterrupted();
    rtvi.userStoppedSpeaking();
    rtvi.botLlmStarted();
    rtvi.botLlmStopped();
    rtvi.botTtsStarted();
    rtvi.botTtsStopped();
    rtvi.botStartedSpeaking();
    rtvi.botStoppedSpeaking();
    expect(sent.every((m) => Object.keys(m).join() === "label,type")).toBe(true);
    expect(types()).toEqual([
      "user-started-speaking",
      "bot-interrupted",
      "user-stopped-speaking",
      "bot-llm-started",
      "bot-llm-stopped",
      "bot-tts-started",
      "bot-tts-stopped",
      "bot-started-speaking",
      "bot-stopped-speaking",
    ]);
  });

  test("a transcription goes out as user-input, then user-transcription, stamped alike", () => {
    rtvi.userTranscription("我想问", false);
    expect(wire()).toEqual([
      '{"label":"rtvi-ai","type":"user-input","data":{"text":"我想问","input_type":"transcription",' +
        '"timestamp":"2026-11-09T00:41:18.588+00:00","final":false,"user_id":""}}',
      '{"label":"rtvi-ai","type":"user-transcription","data":{"text":"我想问","user_id":"",' +
        '"timestamp":"2026-11-09T00:41:18.588+00:00","final":false}}',
    ]);
  });

  test("typed text echoes the message id and names no user", () => {
    rtvi.userTyped("你好", "5ef602d7");
    rtvi.userLlmText("你好");
    expect(wire()).toEqual([
      '{"label":"rtvi-ai","type":"user-input","data":{"text":"你好","input_type":"chat",' +
        '"timestamp":"2026-11-09T00:41:18.588+00:00","final":true,"msg_id":"5ef602d7"}}',
      '{"label":"rtvi-ai","type":"user-llm-text","data":{"text":"你好"}}',
    ]);
  });

  test("errors are never fatal, and only a reply to a client message has an id", () => {
    rtvi.error("Error during completion: boom");
    rtvi.errorResponse("m9", "Unsupported type dtmf");
    expect(wire()).toEqual([
      '{"label":"rtvi-ai","type":"error","data":{"error":"Error during completion: boom","fatal":false}}',
      '{"label":"rtvi-ai","type":"error-response","id":"m9","data":{"error":"Unsupported type dtmf"}}',
    ]);
  });

  test("tool calls report only their id", () => {
    rtvi.toolStarted();
    rtvi.toolInProgress("call_1");
    rtvi.toolStopped("call_1", false);
    rtvi.toolStopped("call_2", true);
    expect(sent.map((m) => m.data)).toEqual([
      {},
      { tool_call_id: "call_1" },
      { tool_call_id: "call_1", cancelled: false },
      { tool_call_id: "call_2", cancelled: true },
    ]);
  });

  test("a server message's data goes out as given, nulls included", () => {
    rtvi.serverMessage({ type: "selfie", urls: ["/a.png"], caption: null });
    expect(wire()).toEqual([
      '{"label":"rtvi-ai","type":"server-message","data":{"type":"selfie","urls":["/a.png"],"caption":null}}',
    ]);
  });
});

describe("RtviEmitter bot-output", () => {
  const output = () => sent.filter((m) => m.type === "bot-output").map((m) => m.data);

  test("a segment without word timings goes new, then completed with bot-tts-text", () => {
    rtvi.segment(tag(0), "早啊……");
    rtvi.segmentStarted(tag(0));
    rtvi.segmentEnded(tag(0));
    expect(types()).toEqual(["bot-transcription", "bot-output", "bot-output", "bot-tts-text"]);
    expect(wire()).toEqual([
      '{"label":"rtvi-ai","type":"bot-transcription","data":{"text":"早啊……"}}',
      '{"label":"rtvi-ai","type":"bot-output","data":{"text":"早啊……","text_type":"sentence",' +
        '"aggregated_by":"sentence","segment_id":1,"spoken":false,"will_be_spoken":true,' +
        '"spoken_status":"new","spoken_progress":{"accumulated_text":"","remaining_text":"早啊……"}}}',
      '{"label":"rtvi-ai","type":"bot-output","data":{"text":"早啊……","text_type":"sentence",' +
        '"aggregated_by":"sentence","segment_id":1,"spoken":true,"will_be_spoken":true,' +
        '"spoken_status":"completed","spoken_progress":{"accumulated_text":"早啊……","remaining_text":""}}}',
      '{"label":"rtvi-ai","type":"bot-tts-text","data":{"text":"早啊……"}}',
    ]);
  });

  test("word progress reports in-progress, and completes at the text's end", () => {
    rtvi.segment(tag(0), "Hi there.");
    rtvi.segmentStarted(tag(0));
    rtvi.segmentProgress(tag(0), 2);
    rtvi.segmentProgress(tag(0), 9);
    rtvi.segmentEnded(tag(0));
    expect(output()).toEqual([
      expect.objectContaining({ spoken_status: "new" }),
      {
        text: "Hi there.",
        text_type: "sentence",
        aggregated_by: "sentence",
        segment_id: 1,
        will_be_spoken: true,
        spoken_status: "in-progress",
        spoken_progress: { accumulated_text: "Hi", remaining_text: " there." },
      },
      {
        text: "Hi there.",
        text_type: "sentence",
        aggregated_by: "sentence",
        segment_id: 1,
        will_be_spoken: true,
        spoken_status: "completed",
        spoken_progress: { accumulated_text: "Hi there.", remaining_text: "" },
      },
    ]);
    expect(types().at(-1)).toBe("bot-tts-text");
  });

  test("ids count from 1 in segment order, and a tag differs by reply, persona and segment", () => {
    rtvi.segment(tag(0), "a");
    rtvi.segment(tag(1), "b");
    rtvi.segment(tag(0, "r2"), "c");
    rtvi.segment(tag(0, "r1", "other"), "d");
    for (const t of [tag(1), tag(0), tag(0, "r2"), tag(0, "r1", "other")]) rtvi.segmentStarted(t);
    expect(output().map((d) => [d?.segment_id, d?.text])).toEqual([
      [2, "b"],
      [1, "a"],
      [3, "c"],
      [4, "d"],
    ]);
  });

  test("a segment says nothing before the cursor reaches it, and completes once", () => {
    rtvi.segment(tag(0), "a");
    rtvi.segmentProgress(tag(0), 1);
    rtvi.segmentEnded(tag(0));
    rtvi.segmentStarted(tag(9));
    expect(types()).toEqual(["bot-transcription"]);
    rtvi.segmentStarted(tag(0));
    rtvi.segmentStarted(tag(0));
    rtvi.segmentEnded(tag(0));
    rtvi.segmentEnded(tag(0));
    rtvi.segmentProgress(tag(0), 1);
    expect(output().map((d) => d?.spoken_status)).toEqual(["new", "completed"]);
  });

  test("an interruption forgets the cut reply's segments; ids go on", () => {
    rtvi.segment(tag(0), "a");
    rtvi.segment(tag(1), "b");
    rtvi.segmentStarted(tag(0));
    rtvi.botInterrupted();
    rtvi.segmentEnded(tag(0));
    rtvi.segmentStarted(tag(1));
    rtvi.segment(tag(0, "r2"), "c");
    rtvi.segmentStarted(tag(0, "r2"));
    expect(output().map((d) => [d?.segment_id, d?.spoken_status])).toEqual([
      [1, "new"],
      [3, "new"],
    ]);
  });
});
