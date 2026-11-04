import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RTVIModelLike } from "@pipedog/core/processors/frameworks/rtvi/processor";
import { BOT_ABOUT } from "../src/index.ts";
import { LaplaceRTVIProcessor } from "../src/rtvi.ts";
import { captureLogs, type LogCapture } from "./support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

/** The processor with its transport push captured and no worker behind it. */
function readyProcessor(): { rtvi: LaplaceRTVIProcessor; sent: Record<string, unknown>[] } {
  const rtvi = new LaplaceRTVIProcessor();
  const sent: Record<string, unknown>[] = [];
  Object.defineProperty(rtvi, "pipelineWorker", { value: { capabilities: null } });
  rtvi.pushTransportMessage = async (model: RTVIModelLike) => {
    sent.push(model.modelDump());
  };
  return { rtvi, sent };
}

function aboutOf(message: Record<string, unknown> | undefined): unknown {
  return (message?.data as Record<string, unknown> | undefined)?.about;
}

describe("LaplaceRTVIProcessor.setBotReady", () => {
  test("a missing or empty about becomes BOT_ABOUT", async () => {
    const { rtvi, sent } = readyProcessor();
    await rtvi.setBotReady();
    await rtvi.setBotReady(null);
    await rtvi.setBotReady({});
    expect(sent.map(aboutOf)).toEqual([BOT_ABOUT, BOT_ABOUT, BOT_ABOUT]);
    expect(sent[0]?.type).toBe("bot-ready");
  });

  test("a non-empty about passes through", async () => {
    const { rtvi, sent } = readyProcessor();
    await rtvi.setBotReady({ library: "x" });
    expect(sent.map(aboutOf)).toEqual([{ library: "x" }]);
  });

  test("BOT_ABOUT is the pyproject identity, frozen", () => {
    expect(BOT_ABOUT).toEqual({ library: "laplace-eidolon", library_version: "0.2.0" });
    expect(Object.isFrozen(BOT_ABOUT)).toBe(true);
  });
});
