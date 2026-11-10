// The caller talking over her: while she speaks, and while she is still thinking.
import { describe, expect, test } from "bun:test";
import { assertParity, runTwin } from "../twin.ts";
import {
  cutOff,
  finished,
  GREETING,
  greeted,
  LONG_REPLY,
  QUESTION,
  SCENARIO_MS,
  SHORT_REPLY,
  TWIN,
} from "./script.ts";

describe.skipIf(!TWIN)("twin: barge-in", () => {
  test(
    "mid-sentence",
    async () => {
      const twin = await runTwin({
        name: "barge-in mid-sentence",
        mind: [GREETING, LONG_REPLY, SHORT_REPLY],
        heard: ["给我讲讲花店", "等一下"],
        async run({ peer }) {
          await greeted(peer);
          await peer.say(QUESTION);
          await peer.waitFor("bot-started-speaking", 2);
          await Bun.sleep(300);
          await peer.say(QUESTION);
          await finished(peer, 3);
        },
      });
      assertParity(twin);
      expect(cutOff(twin.native)).toBe(true);
    },
    SCENARIO_MS,
  );

  test(
    "before her first audio",
    async () => {
      const twin = await runTwin({
        name: "barge-in before the first audio",
        mind: [GREETING, { ...LONG_REPLY, firstDeltaMs: 4000 }, SHORT_REPLY],
        heard: ["给我讲讲花店", "算了"],
        async run({ peer }) {
          await greeted(peer);
          await peer.say(QUESTION);
          await peer.waitFor("bot-llm-started", 2);
          await peer.say(QUESTION);
          await finished(peer, 2);
        },
      });
      assertParity(twin);
    },
    SCENARIO_MS,
  );
});
