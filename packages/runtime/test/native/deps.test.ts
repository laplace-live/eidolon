// What a call runs on outside the tests, and the models it warms.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultEngineDeps, runTurn } from "@eidolon/engine";
import { openRealtime } from "@eidolon/providers/realtime";
import { openSpeech } from "@eidolon/providers/speech-stream";
import { openStt } from "@eidolon/providers/stt";
import { voiceModels } from "@eidolon/voice";
import { warmAudioModels } from "../../src/index.ts";
import { productionCallDeps } from "../../src/native/deps.ts";
import { BOT_ABOUT } from "../../src/rtvi.ts";
import { captureLogs, type LogCapture } from "../support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

describe("productionCallDeps", () => {
  test("calls run on the real engine, clients and models, and bot-ready names this bot", () => {
    const deps = productionCallDeps;
    expect(deps.runTurn).toBe(runTurn);
    expect(deps.openStt).toBe(openStt);
    expect(deps.openSpeech).toBe(openSpeech);
    expect(deps.openRealtime).toBe(openRealtime);
    expect(deps.models).toEqual(voiceModels());
    expect(deps.about).toEqual(BOT_ABOUT);
    const engine = defaultEngineDeps({ saveAttachment: async () => ({}) as never });
    expect(deps.engine.createMind).toBe(engine.createMind);
    expect(deps.engine.parts).toBe(engine.parts);
  });

  test("a call stores no files", async () => {
    await expect(
      productionCallDeps.engine.saveAttachment(new Uint8Array(1), "image/png"),
    ).rejects.toThrow("A call keeps no files");
  });

  test("its clock's timers fire, and stay quiet once cancelled", async () => {
    const { clock } = productionCallDeps;
    const fired: string[] = [];
    const start = clock.now();
    clock.setTimer(5, () => fired.push("kept"));
    const cancel = clock.setTimer(5, () => fired.push("cancelled"));
    cancel();
    await Bun.sleep(30);
    expect(fired).toEqual(["kept"]);
    expect(clock.now() - start).toBeGreaterThanOrEqual(5);
  });
});

describe("the hearing models", () => {
  test("the warm-up loads them, and succeeds", async () => {
    await warmAudioModels();
  }, 30_000);
});
