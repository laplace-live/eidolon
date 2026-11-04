import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as runtime from "../src/index.ts";
import { productionSessionDeps } from "../src/session/defaults.ts";
import { createLlm, createStt, createTts } from "../src/session/services.ts";
import { captureLogs, type LogCapture } from "./support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

describe("@eidolon/runtime", () => {
  test("exports exactly the pipedog-free surface apps/bot uses", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "BOT_ABOUT",
      "configureLogging",
      "createSignallingServer",
      "warmAudioModels",
    ]);
  });

  test("a signalling server answers malformed requests without touching ICE", async () => {
    let plans = 0;
    const signalling = runtime.createSignallingServer({
      ice: {
        serverPlan: async () => {
          plans++;
          return { iceServers: [], relayOnly: false, turnUrl: null };
        },
      },
    });
    expect(signalling.activeSessions).toBe(0);
    expect((await signalling.patch("not json")).status).toBe(400);
    expect(await signalling.patch(JSON.stringify({ pc_id: "x" }))).toEqual({
      status: 404,
      body: { detail: "Peer connection not found" },
    });
    expect(plans).toBe(0);
    await signalling.close();
  });

  test("sessions are built from the real services and bot.py's empty-turn prompt", () => {
    expect(productionSessionDeps.createStt).toBe(createStt);
    expect(productionSessionDeps.createTts).toBe(createTts);
    expect(productionSessionDeps.createLlm).toBe(createLlm);
    expect(productionSessionDeps.interruptedEmptyTurnPrompt).toBe(
      "你刚才说话的时候，好像说了句什么，但没听清。" +
        "你的话在那儿被打断了，对话里只留下ta听到的部分，也可能一句都没听到。" +
        "用一句话自然地请ta再说一遍；" +
        "如果你刚才问了问题，ta可能没听到，就顺带再问一次。",
    );
  });
});
