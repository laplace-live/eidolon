// A spoken question, answered in two sentences.
import { describe, test } from "bun:test";
import { assertParity, runTwin } from "../twin.ts";
import { finished, GREETING, greeted, QUESTION, SCENARIO_MS, TWIN } from "./script.ts";

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
    },
    SCENARIO_MS,
  );
});
