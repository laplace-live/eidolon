import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lookup } from "node:dns/promises";
import type { IceService } from "@eidolon/turn";
import type { BotArgs } from "../src/args.ts";
import { type BotDeps, type BotServer, shutdownHandler, startBotServer } from "../src/server.ts";
import { type CapturedLogs, captureLogs, deferred, fakeAccess } from "./fakes.ts";

const ARGS: BotArgs = { host: "127.0.0.1", port: 0, verbose: 0 };
const SETTINGS = {
  presetsBps: { best: 192000, medium: 96000, low: 64000, lowest: 8000 },
  defaultBitrateBps: 96000,
};
const OPUS_LINE =
  "[WebRTC] Opus encoder bitrate: default 96 kbps, presets best=192kbps, medium=96kbps, low=64kbps, lowest=8kbps";

interface Recorded {
  calls: string[];
  ice: IceService;
}

function fakeDeps(overrides: { warmAudioModels?: () => Promise<void> } = {}): {
  deps: BotDeps;
  recorded: Recorded;
} {
  const calls: string[] = [];
  const recorded: Recorded = {
    calls,
    ice: {
      browserPayload: async () => {
        calls.push("ice.browserPayload");
        return { iceServers: [{ urls: ["stun:stun.example:3478"] }] };
      },
      serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }),
    },
  };
  const deps: BotDeps = {
    access: {
      ...fakeAccess(),
      corsPolicyFromEnv: () => {
        calls.push("corsPolicyFromEnv");
        return { allowOrigins: [] };
      },
      anonOfferQuota: () => {
        calls.push("anonOfferQuota");
        return { maxPerWindow: 5, windowSeconds: 3600 };
      },
      audioQualitySettings: () => {
        calls.push("audioQualitySettings");
        return SETTINGS;
      },
      describeOpusBitrates: (settings) => {
        calls.push("describeOpusBitrates");
        expect(settings).toBe(SETTINGS);
        return OPUS_LINE;
      },
    },
    imagegen: { selfieResponse: () => new Response(null, { status: 404 }) },
    memory: {
      memoryAdmin: () => {
        calls.push("memoryAdmin");
        return null;
      },
    },
    retrieval: {
      warmTokenizer: () => {
        calls.push("warmTokenizer");
      },
      resolveDbPath: () => {
        calls.push("resolveDbPath");
        return "/fake/data/lancedb";
      },
      warmStreamCatalog: async (dbPath) => {
        calls.push(`warmStreamCatalog ${dbPath}`);
      },
    },
    runtime: {
      configureLogging: ({ level }) => {
        calls.push(`configureLogging ${level}`);
      },
      warmAudioModels:
        overrides.warmAudioModels ??
        (async () => {
          calls.push("warmAudioModels");
        }),
      createSignallingServer: ({ ice }) => {
        calls.push(`createSignallingServer ${ice === recorded.ice ? "shared ice" : "other ice"}`);
        return {
          offer: async () => ({ status: 200, body: {} }),
          patch: async () => ({ status: 200, body: {} }),
          close: async () => {},
        };
      },
    },
    turn: {
      iceServiceFromEnv: () => {
        calls.push("iceServiceFromEnv");
        return recorded.ice;
      },
    },
    mcp: {
      createMcpHandler: async () => {
        calls.push("createMcpHandler");
        return { handle: async () => new Response("mcp") };
      },
    },
  };
  return { deps, recorded };
}

let logs: CapturedLogs;
let bot: BotServer | null = null;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(async () => {
  logs.restore();
  await bot?.stop();
  bot = null;
});

describe("startBotServer", () => {
  test("boots in order, logs the install lines, then listens", async () => {
    const { deps, recorded } = fakeDeps();
    bot = await startBotServer(ARGS, deps);
    expect(recorded.calls).toEqual([
      "configureLogging DEBUG",
      "warmTokenizer",
      "resolveDbPath",
      "warmStreamCatalog /fake/data/lancedb",
      "warmAudioModels",
      "audioQualitySettings",
      "describeOpusBitrates",
      "iceServiceFromEnv",
      "createSignallingServer shared ice",
      "anonOfferQuota",
      "corsPolicyFromEnv",
      "memoryAdmin",
      "createMcpHandler",
    ]);
    expect(logs.lines()).toEqual([
      `INFO ${OPUS_LINE}`,
      "INFO [offer-middleware] Installed on /api/offer (anonymous quota: 5/3600s)",
      "INFO [memory-admin] Installed routes: GET /api/memories, POST /api/memories/forget",
      "INFO [selfie] Installed route: GET /api/selfie/{selfie_id}",
      `INFO Bot server listening on http://127.0.0.1:${bot.server.port}/`,
    ]);
  });

  test("GET /api/ice-servers is served by the IceService the signalling server got", async () => {
    const { deps, recorded } = fakeDeps();
    bot = await startBotServer(ARGS, deps);
    const response = await fetch(`http://127.0.0.1:${bot.server.port}/api/ice-servers`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"iceServers":[{"urls":["stun:stun.example:3478"]}]}');
    expect(recorded.calls).toContain("createSignallingServer shared ice");
    expect(recorded.calls.at(-1)).toBe("ice.browserPayload");
  });

  test("localhost listens on every address it resolves to, as uvicorn does", async () => {
    const { deps } = fakeDeps();
    bot = await startBotServer({ ...ARGS, host: "localhost" }, deps);
    const port = bot.server.port;
    const addresses = new Set((await lookup("localhost", { all: true })).map((a) => a.address));
    for (const address of addresses) {
      const host = address.includes(":") ? `[${address}]` : address;
      expect((await fetch(`http://${host}:${port}/api/ice-servers`)).status).toBe(200);
    }
    expect(logs.lines().at(-1)).toBe(`INFO Bot server listening on http://localhost:${port}/`);
    await bot.stop();
    for (const address of addresses) {
      const host = address.includes(":") ? `[${address}]` : address;
      const refused = await fetch(`http://${host}:${port}/api/ice-servers`).then(
        () => false,
        () => true,
      );
      expect(refused).toBe(true);
    }
    bot = null;
  });

  test("-v logs at TRACE", async () => {
    const { deps, recorded } = fakeDeps();
    bot = await startBotServer({ ...ARGS, verbose: 2 }, deps);
    expect(recorded.calls[0]).toBe("configureLogging TRACE");
  });

  test("listens only after the audio models are warm", async () => {
    const warm = deferred();
    const { deps, recorded } = fakeDeps({ warmAudioModels: () => warm.promise });
    const booting = startBotServer(ARGS, deps);
    await Bun.sleep(10);
    expect(recorded.calls).not.toContain("iceServiceFromEnv");
    expect(recorded.calls).not.toContain("createMcpHandler");
    expect(logs.records).toEqual([]);
    warm.resolve();
    bot = await booting;
    expect(recorded.calls.at(-1)).toBe("createMcpHandler");
  });

  test("a failed warm-up fails the boot before anything listens", async () => {
    const { deps, recorded } = fakeDeps({
      warmAudioModels: async () => {
        throw new Error("smart-turn-v3.2-cpu.onnx failed to load");
      },
    });
    await expect(startBotServer(ARGS, deps)).rejects.toThrow("failed to load");
    expect(recorded.calls).not.toContain("createSignallingServer shared ice");
    expect(logs.records).toEqual([]);
  });

  test("stop() stops listening before it disconnects the peers", async () => {
    const { deps } = fakeDeps();
    const closes: { listening: boolean }[] = [];
    const create = deps.runtime.createSignallingServer;
    const server = await startBotServer(ARGS, {
      ...deps,
      runtime: {
        ...deps.runtime,
        createSignallingServer: (options) => ({
          ...create(options),
          close: async () => {
            const url = `http://127.0.0.1:${server.server.port}/api/ice-servers`;
            const listening = await fetch(url).then(
              () => true,
              () => false,
            );
            closes.push({ listening });
          },
        }),
      },
    });
    await server.stop();
    expect(closes).toEqual([{ listening: false }]);
  });
});

describe("shutdownHandler", () => {
  test("stops once, then exits 0", async () => {
    const exits: number[] = [];
    const stopped = deferred();
    let stops = 0;
    const onSignal = shutdownHandler(
      {
        stop: () => {
          stops++;
          return stopped.promise;
        },
      },
      (code) => exits.push(code),
    );
    onSignal();
    await Bun.sleep(0);
    expect(exits).toEqual([]);
    stopped.resolve();
    await Bun.sleep(0);
    expect(stops).toBe(1);
    expect(exits).toEqual([0]);
  });

  test("a second signal while stopping exits at once", () => {
    const exits: number[] = [];
    let stops = 0;
    const onSignal = shutdownHandler(
      {
        stop: () => {
          stops++;
          return new Promise(() => {});
        },
      },
      (code) => exits.push(code),
    );
    onSignal();
    onSignal();
    expect(stops).toBe(1);
    expect(exits).toEqual([0]);
  });

  test("a failed stop is logged and still exits 0", async () => {
    const exits: number[] = [];
    const onSignal = shutdownHandler(
      { stop: async () => Promise.reject(new Error("peer close hung up")) },
      (code) => exits.push(code),
    );
    onSignal();
    await Bun.sleep(0);
    expect(exits).toEqual([0]);
    expect(logs.lines()).toEqual(["ERROR Shutdown failed"]);
  });
});
