// A turn the recognizer makes no words of: ignored while she is idle, a recovery prompt after it
// cut her off.
import { describe, expect, test } from "bun:test";
import { assertParity, rulesUsed, runTwin } from "../twin.ts";
import {
  COUGH,
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

describe.skipIf(!TWIN)("twin: empty turns", () => {
  test(
    "while she is idle, no mind request",
    async () => {
      const twin = await runTwin({
        name: "empty turn while idle",
        mind: [GREETING],
        async run({ peer }) {
          await greeted(peer);
          await peer.say(COUGH);
          await peer.waitFor("user-stopped-speaking", 1, 15_000);
          await peer.quiet(2_000);
        },
      });
      assertParity(twin);
    },
    SCENARIO_MS,
  );

  test(
    "after cutting her off, the recovery prompt",
    async () => {
      const twin = await runTwin({
        name: "empty turn after interrupting",
        mind: [GREETING, LONG_REPLY, SHORT_REPLY],
        heard: ["给我讲讲花店"],
        async run({ peer }) {
          await greeted(peer);
          await peer.say(QUESTION);
          await peer.waitFor("bot-started-speaking", 2);
          await Bun.sleep(300);
          await peer.say(COUGH);
          await finished(peer, 3);
        },
      });
      assertParity(twin);
      expect(cutOff(twin.native)).toBe(true);
    },
    SCENARIO_MS,
  );

  test(
    "just after her audio ended, which pipedog still counts as cutting her off (D13)",
    async () => {
      const twin = await runTwin({
        name: "empty turn after her audio",
        mind: [GREETING, LONG_REPLY, SHORT_REPLY],
        heard: ["给我讲讲花店"],
        async run({ peer }) {
          await greeted(peer);
          const asked = peer.now();
          await peer.say(QUESTION);
          await peer.waitFor("bot-started-speaking", 2);
          // pipedog says she stopped speaking about 3 s after her audio: a cough inside that
          // window is an interruption to it, and gets the recovery prompt.
          await peer.audioEnded(asked, 300);
          await peer.say(COUGH);
          await peer.waitFor("user-stopped-speaking", 2);
          await peer.quiet(5_000);
        },
      });
      assertParity(twin);
      expect(rulesUsed(twin)).toContain("D13");
    },
    SCENARIO_MS,
  );
});
