// What a call does when a provider fails: a mind role with no key, a mind request that errors, a
// call naming a tool she doesn't have, a recognizer socket that drops and comes back.
import { describe, expect, test } from "bun:test";
import {
  assertParity,
  type Capture,
  type Difference,
  judge,
  report,
  runTwin,
  violations,
} from "../twin.ts";
import {
  clientReady,
  finished,
  GREETING,
  greeted,
  QUESTION,
  SCENARIO_MS,
  SHORT_REPLY,
  sendText,
  TWIN,
} from "./script.ts";

const SESSION_FAILED = "Bot session failed: ";

describe.skipIf(!TWIN)("twin: failures", () => {
  test(
    "a mind account with no key fails the call before it connects",
    async () => {
      const twin = await runTwin({
        name: "mind with no key",
        keyless: ["mind"],
        failsToStart: true,
        async run({ peer }) {
          // client-js says it is ready once the channel opens, which a call that failed never opens.
          if (await peer.opens(5_000)) {
            clientReady(peer);
            await Bun.sleep(3_000);
          }
        },
      });
      assertParity(twin);
      const failures = (c: Capture) =>
        c.logs.filter((r) => r.message.startsWith(SESSION_FAILED)).map((r) => r.message);
      expect(failures(twin.pipedog)).toEqual([expect.stringContaining("no API key")]);
      expect(failures(twin.native)).toEqual(failures(twin.pipedog));
    },
    SCENARIO_MS,
  );

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

  // The engines also differ beyond allowed.ts in that call's result, which pipedog's
  // missing-function handler gives as a bare string and native as `{"error": …}`: the user's call.
  // Everything else must hold as assertParity holds it.
  test(
    "a call naming a tool she doesn't have is in progress, then stopped, after her round",
    async () => {
      const twin = await runTwin({
        name: "unknown tool",
        mind: [
          GREETING,
          {
            toolCalls: [
              { id: "call_missing_1", name: "water_the_plants", arguments: {} },
              { id: "call_missing_2", name: "feed_the_cat", arguments: {} },
            ],
          },
          SHORT_REPLY,
        ],
        async run({ peer }) {
          await greeted(peer);
          sendText(peer, "帮我浇浇花");
          await finished(peer, 2);
        },
      });
      const result = (d: Difference) =>
        (d.kind === "mind" || d.kind === "conversation") &&
        d.change === "changed" &&
        /^call_missing_/.test(String((d.native as { tool_call_id?: unknown }).tool_call_id));
      const unexplained = judge(twin).filter((j) => j.rule === null && !result(j.difference));
      const broken = violations(twin);
      const ended = twin.pipedog.ended && twin.native.ended;
      const failed = twin.pipedog.failed ?? twin.native.failed;
      if (
        unexplained.length + broken.pipedog.length + broken.native.length > 0 ||
        !ended ||
        failed
      ) {
        throw new Error(`the engines differ beyond allowed.ts:\n${report(twin)}`);
      }
      const tools = (c: Capture) =>
        c.received
          .map((r) => r.message)
          .filter((m) => m.type === "bot-llm-stopped" || /^llm-function-call-/.test(String(m.type)))
          .map((m) => `${m.type} ${String((m.data as { tool_call_id?: unknown })?.tool_call_id)}`);
      expect(tools(twin.native)).toEqual(tools(twin.pipedog));
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
