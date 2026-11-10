// A realtime persona's call, on each engine, against a realtime server in each dialect: the
// greeting, a spoken question, the caller talking over her, typed lines, and a fatal error. The
// server's VAD hears the caller, so the scenario tells the fake when the caller speaks.
//
// Not here: a barge-in before a response's transcript has all arrived. pipedog's observer then
// joins the cut sentence to the next reply's in one bot-transcription, a pipedog defect no rule in
// allowed.ts names; native's held sentence goes with its cut reply.
import { describe, expect, test } from "bun:test";
import type { RealtimeDialect, RealtimeReply } from "../fakes/realtime.ts";
import { assertParity, normalizeRealtime, rulesUsed, runTwin, type Twin } from "../twin.ts";
import { clientReady, cutOff, finished, SCENARIO_MS, sendText, TWIN } from "./script.ts";

const GREETING: RealtimeReply = { segments: ["你好呀，", "欢迎来花店。", "今天想聊点什么？"] };
// Each answer plays for longer than the second pipedog's aggregator waits before it writes the
// caller's line, as real replies do: with a shorter one pipedog never sends its user-llm-text.
const ANSWER: RealtimeReply = {
  segments: ["嗯，", "今天花店来了好多新的花，", "有玫瑰也有向日葵。"],
  msPerChar: 80,
};
const SHORT: RealtimeReply = {
  segments: ["好呀，", "那我们慢慢聊，", "你想先看哪一种呢？"],
  msPerChar: 80,
};

/** What native's realtime server got, as the twin compares it. */
const sent = (twin: Twin) => normalizeRealtime(twin.native.realtime).map((m) => m.type);

for (const dialect of ["openai", "xai"] as const satisfies readonly RealtimeDialect[]) {
  const replies = [GREETING, ANSWER, SHORT];
  /** The rules every realtime reply uses: per-sentence bot-output, one llm pair per response. */
  const always = dialect === "xai" ? ["E4", "E5", "D4"] : ["E4", "E5"];

  describe.skipIf(!TWIN)(`twin: a realtime call on ${dialect}`, () => {
    test(
      "she greets the caller, her kickoff the conversation's one item",
      async () => {
        const twin = await runTwin({
          name: `${dialect} realtime greeting`,
          realtime: { dialect, replies },
          async run({ peer }) {
            clientReady(peer);
            await peer.waitFor("bot-ready");
            await finished(peer, 1);
          },
        });
        assertParity(twin);
        expect(sent(twin)).toEqual(["session", "conversation.item.create", "response.create"]);
        for (const rule of always) expect(rulesUsed(twin)).toContain(rule);
      },
      SCENARIO_MS,
    );

    test(
      "a spoken question, heard by the server's VAD, and her reply",
      async () => {
        const twin = await runTwin({
          name: `${dialect} realtime question`,
          realtime: { dialect, replies },
          async run({ peer, fakes }) {
            clientReady(peer);
            await finished(peer, 1);
            await fakes.realtime?.userSays("给我讲讲花店");
            await finished(peer, 2);
          },
        });
        assertParity(twin);
        // OpenAI's transcription comes in deltas: native's interims add up (E3).
        if (dialect === "openai") expect(rulesUsed(twin)).toContain("E3");
      },
      SCENARIO_MS,
    );

    test(
      "the caller talks over her: her audio stops and its item is truncated",
      async () => {
        const twin = await runTwin({
          name: `${dialect} realtime barge-in`,
          realtime: { dialect, replies },
          async run({ peer, fakes }) {
            clientReady(peer);
            await finished(peer, 1);
            const server = fakes.realtime;
            if (server === null) throw new Error("no realtime server");
            await server.userSays("给我讲讲花店");
            await peer.waitFor("bot-started-speaking", 2);
            await server.idle();
            await server.userSays("等一下");
            await finished(peer, 3);
          },
        });
        assertParity(twin);
        expect(cutOff(twin.native)).toBe(true);
        expect(sent(twin)).toContain("conversation.item.truncate");
      },
      SCENARIO_MS,
    );

    test(
      "a line typed while she is idle is answered (E2)",
      async () => {
        const twin = await runTwin({
          name: `${dialect} realtime typed line`,
          realtime: { dialect, replies },
          async run({ peer }) {
            clientReady(peer);
            await finished(peer, 1);
            sendText(peer, "给我讲讲花店");
            await peer.quiet(3_000);
          },
        });
        assertParity(twin);
        expect(sent(twin).slice(-2)).toEqual(["conversation.item.create", "response.create"]);
        expect(rulesUsed(twin)).toContain("E2");
      },
      SCENARIO_MS,
    );

    test(
      "a line typed while she speaks cuts her off and is answered (E2)",
      async () => {
        const twin = await runTwin({
          name: `${dialect} realtime typed line while she speaks`,
          realtime: { dialect, replies },
          async run({ peer, fakes }) {
            clientReady(peer);
            await peer.waitFor("bot-started-speaking");
            await fakes.realtime?.idle();
            sendText(peer, "等一下");
            await peer.quiet(3_000);
          },
        });
        assertParity(twin);
        expect(cutOff(twin.native)).toBe(true);
        expect(rulesUsed(twin)).toContain("E2");
      },
      SCENARIO_MS,
    );

    test(
      "a fatal server error is reported, and ends the native call (E8)",
      async () => {
        const twin = await runTwin({
          name: `${dialect} realtime fatal error`,
          realtime: { dialect, replies },
          async run({ peer, fakes }) {
            clientReady(peer);
            await finished(peer, 1);
            fakes.realtime?.fail("The server had an error");
            await peer.quiet(1_500);
          },
        });
        assertParity(twin);
        const last = twin.native.received.at(-1)?.message;
        expect(last).toEqual({ type: "signalling", message: { type: "peerLeft" } });
      },
      SCENARIO_MS,
    );
  });
}
