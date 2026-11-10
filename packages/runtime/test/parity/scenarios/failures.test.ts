// What a call does when a provider fails: a mind request that errors, a recognizer socket that
// drops and comes back.
import { describe, test } from "bun:test";
import { assertParity, runTwin } from "../twin.ts";
import {
  finished,
  GREETING,
  greeted,
  QUESTION,
  SCENARIO_MS,
  SHORT_REPLY,
  sendText,
  TWIN,
} from "./script.ts";

describe.skipIf(!TWIN)("twin: failures", () => {
  test(
    "a mind request that fails tells the client, and the call goes on",
    async () => {
      const twin = await runTwin({
        name: "mind error",
        // A 400: the client retries a 5xx, and its retry would take the next reply.
        mind: [GREETING, { error: { status: 400, message: "bad request" } }, SHORT_REPLY],
        async run({ peer }) {
          await greeted(peer);
          sendText(peer, "给我讲讲花店");
          await peer.waitFor("error", 1, 15_000);
          await peer.quiet(1_500);
          sendText(peer, "那我们聊聊天吧");
          await finished(peer, 2);
        },
      });
      assertParity(twin);
    },
    SCENARIO_MS,
  );

  test(
    "the recognizer's socket drops, reconnects, and hears the next question",
    async () => {
      const twin = await runTwin({
        name: "STT reconnect",
        mind: [GREETING, SHORT_REPLY],
        heard: ["你还在吗"],
        async run({ peer, fakes }) {
          await greeted(peer);
          fakes.soniox.drop();
          const deadline = performance.now() + 20_000;
          while (fakes.soniox.connections.length < 2) {
            if (performance.now() > deadline) throw new Error("the recognizer never reconnected");
            await Bun.sleep(20);
          }
          await Bun.sleep(500);
          await peer.say(QUESTION);
          await finished(peer, 2);
        },
      });
      assertParity(twin);
    },
    SCENARIO_MS,
  );
});
