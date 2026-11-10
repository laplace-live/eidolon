// change_voice_style: her next words in the other voice.
import { describe, test } from "bun:test";
import { assertParity, runTwin } from "../twin.ts";
import { finished, GREETING, greeted, SCENARIO_MS, sendText, TWIN } from "./script.ts";

describe.skipIf(!TWIN)("twin: change_voice_style", () => {
  test(
    "a voice switch, then her answer in the new voice",
    async () => {
      const twin = await runTwin({
        name: "change_voice_style",
        env: { TTS_VOICE_ID_WHISPER: "twin-whisper" },
        mind: [
          GREETING,
          {
            toolCalls: [
              { id: "call_voice_1", name: "change_voice_style", arguments: { style: "whisper" } },
            ],
          },
          { deltas: ["[小声] 嗯，", "这样可以嘛。"], deltaMs: 40 },
        ],
        async run({ peer }) {
          await greeted(peer);
          sendText(peer, "你小声一点说话");
          await finished(peer, 2);
        },
      });
      assertParity(twin);
    },
    SCENARIO_MS,
  );
});
