import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { logger } from "@eidolon/config";
import * as runtime from "../src/index.ts";
import { captureLogs, type LogCapture } from "./support.ts";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => logs.restore());

describe("@eidolon/runtime", () => {
  test("exports exactly the surface apps/bot uses", () => {
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

  test("configureLogging sets the logger's level", () => {
    runtime.configureLogging({ level: "INFO" });
    expect([logger.isEnabledFor("DEBUG"), logger.isEnabledFor("INFO")]).toEqual([false, true]);
  });
});
