// The greeting, and typed questions while she is idle.
import { describe, test } from "bun:test";
import { assertParity, runTwin } from "../twin.ts";
import {
  finished,
  GREETING,
  greeted,
  LONG_REPLY,
  SCENARIO_MS,
  SHORT_REPLY,
  sendText,
  TWIN,
} from "./script.ts";

describe.skipIf(!TWIN)("twin: the greeting and typed text", () => {
  test(
    "she greets the caller once the client is ready",
    async () => {
      const twin = await runTwin({
        name: "greeting",
        mind: [GREETING],
        run: ({ peer }) => greeted(peer),
      });
      assertParity(twin);
    },
    SCENARIO_MS,
  );

  test(
    "send-text run_immediately while she is idle",
    async () => {
      const twin = await runTwin({
        name: "send-text while idle",
        mind: [GREETING, LONG_REPLY],
        async run({ peer }) {
          await greeted(peer);
          sendText(peer, "给我讲讲花店");
          await finished(peer, 2);
        },
      });
      assertParity(twin);
    },
    SCENARIO_MS,
  );

  // Skipped: the engines differ beyond allowed.ts. pipedog appends a line sent without
  // run_immediately and runs no reply for it (RTVIProcessor's LLMMessagesAppendFrame, runLlm
  // false), so it waits for the caller's next turn; the native Floor answers it at once when she
  // is idle and owes a follow-up when she is busy (docs/voice-engine.md, row 8). No client sends
  // it today; which behavior the call keeps, or a rule for it, is the user's call.
  test.skip(
    "send-text without run_immediately waits for the next turn",
    async () => {
      const twin = await runTwin({
        name: "send-text queued while idle",
        mind: [GREETING, SHORT_REPLY],
        async run({ peer }) {
          await greeted(peer);
          sendText(peer, "我们聊聊天吧", { runImmediately: false });
          await peer.quiet(2_000);
          sendText(peer, "你在吗");
          await finished(peer, 2);
        },
      });
      assertParity(twin);
    },
    SCENARIO_MS,
  );
});
