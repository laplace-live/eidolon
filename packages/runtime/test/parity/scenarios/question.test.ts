// A spoken question, answered in two sentences.
import { describe, expect, test } from "bun:test";
import { assertParity, type Capture, runTwin } from "../twin.ts";
import { finished, GREETING, greeted, QUESTION, SCENARIO_MS, TWIN } from "./script.ts";

const FIRST = "嗯，我今天心情不错。";

/** When the caller got the first sentence's bot-output of `status`. */
function reported(capture: Capture, status: string): number | undefined {
  return capture.received.find(({ message }) => {
    const data = message.data as { text?: unknown; spoken_status?: unknown } | undefined;
    return message.type === "bot-output" && data?.text === FIRST && data.spoken_status === status;
  })?.t;
}

describe.skipIf(!TWIN)("twin: a spoken question", () => {
  test(
    "a question heard, and a two-sentence reply",
    async () => {
      const twin = await runTwin({
        name: "spoken question",
        mind: [GREETING, { deltas: ["嗯，", "我今天心情不错。", "你呢？"], deltaMs: 40 }],
        heard: ["你今天心情怎么样"],
        async run({ peer }) {
          await greeted(peer);
          await peer.say(QUESTION);
          await finished(peer, 2);
        },
      });
      assertParity(twin);
      // D12, required from G5: native completes the first sentence once its audio has played, a
      // second of the fake Fish's tone (100 ms a character) after it was new.
      const native =
        (reported(twin.native, "completed") ?? 0) - (reported(twin.native, "new") ?? 0);
      expect(native).toBeGreaterThan(500);
    },
    SCENARIO_MS,
  );
});
