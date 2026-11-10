// A call longer than her view's window: typed lines and short spoken replies, until her requests
// hold more than 60 lines and the native engine's view starts to drop the oldest (D1).
import { describe, expect, test } from "bun:test";
import type { MindReply } from "../fakes/mind.ts";
import { assertParity, rulesUsed, runTwin } from "../twin.ts";
import { GREETING, greeted, SCENARIO_MS, sendText, TWIN } from "./script.ts";

/** Exchanges after the greeting: with the greeting's two lines, more than 60 in all. */
const EXCHANGES = 31;

describe.skipIf(!TWIN)("twin: a long call", () => {
  test(
    "past 60 lines, the native view keeps the last 60",
    async () => {
      const replies: MindReply[] = Array.from({ length: EXCHANGES }, (_, i) => ({
        deltas: [`第${i + 1}句。`],
      }));
      const twin = await runTwin({
        name: "a call longer than the window",
        mind: [GREETING, ...replies],
        async run({ peer }) {
          await greeted(peer);
          for (let i = 1; i <= EXCHANGES; i++) {
            const asked = peer.now();
            sendText(peer, `问题${i}`);
            await peer.waitFor("bot-started-speaking", i + 1);
            // The next line comes once her audio ends, inside pipedog's late bot-stopped-speaking
            // window (D5), which a typed line closes without cutting anything off.
            await peer.audioEnded(asked, 200);
          }
          await peer.quiet(4_000);
        },
      });
      assertParity(twin);
      expect(rulesUsed(twin)).toContain("D1");
    },
    SCENARIO_MS,
  );
});
