// Typed text while she speaks.
import { describe, expect, test } from "bun:test";
import { assertParity, runTwin } from "../twin.ts";
import {
  cutOff,
  finished,
  GREETING,
  greeted,
  LONG_REPLY,
  SCENARIO_MS,
  SHORT_REPLY,
  sendText,
  TWIN,
} from "./script.ts";

describe.skipIf(!TWIN)("twin: send-text while she speaks", () => {
  test(
    "run_immediately cuts her off and answers the text",
    async () => {
      const twin = await runTwin({
        name: "send-text while speaking",
        mind: [GREETING, LONG_REPLY, SHORT_REPLY],
        async run({ peer }) {
          await greeted(peer);
          sendText(peer, "给我讲讲花店");
          await peer.waitFor("bot-started-speaking", 2);
          await Bun.sleep(500);
          sendText(peer, "等一下");
          await finished(peer, 3);
        },
      });
      assertParity(twin);
      expect(cutOff(twin.native)).toBe(true);
    },
    SCENARIO_MS,
  );

  test(
    "audio_response false answers in text, its sentences still reported",
    async () => {
      const twin = await runTwin({
        name: "send-text answered in text alone",
        mind: [GREETING, SHORT_REPLY],
        async run({ peer }) {
          await greeted(peer);
          sendText(peer, "打字回我就好", { audioResponse: false });
          await peer.waitFor("bot-llm-stopped", 2);
          await peer.quiet(1_500);
        },
      });
      assertParity(twin);
    },
    SCENARIO_MS,
  );
});
