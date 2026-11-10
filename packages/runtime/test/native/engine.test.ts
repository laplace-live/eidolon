// The switch between the engines: how EIDOLON_VOICE_ENGINE reads, which transport answers each
// engine's offers, and a native call's start, on a fake transport with fake providers and the real
// hearing models.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AllowedOffer } from "@eidolon/access";
import { activePersona, pyRepr } from "@eidolon/config";
import type { CallTurnRequest, EngineDeps, Mind } from "@eidolon/engine";
import type { CallDeps } from "@eidolon/voice";
import { Peer } from "@eidolon/webrtc";
import { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import {
  FakeSpeech,
  FakeStt,
  FakeTransport,
  FakeTurn,
  settle,
} from "../../../voice/test/call/harness.ts";
import { FakeClock } from "../../../voice/test/input/clock.ts";
import { voiceModels } from "../../src/audio.ts";
import { createSignallingServer } from "../../src/index.ts";
import { runNativeSafely, voiceEngineFromEnv } from "../../src/native/engine.ts";
import { BOT_ABOUT } from "../../src/rtvi.ts";
import { captureLogs, type LogCapture, admission as offered, setEnv, until } from "../support.ts";

let logs: LogCapture;
let restoreEnv: () => void;
beforeEach(() => {
  logs = captureLogs();
  restoreEnv = setEnv({
    EIDOLON_VOICE_ENGINE: undefined,
    REALTIME_PROVIDER: undefined,
    STT_PROVIDER: undefined,
    TTS_PROVIDER: undefined,
  });
});
afterEach(() => {
  restoreEnv();
  logs.restore();
});

describe("voiceEngineFromEnv", () => {
  test("unset and blank are native, without a word", () => {
    expect(voiceEngineFromEnv()).toBe("native");
    setEnv({ EIDOLON_VOICE_ENGINE: "" });
    expect(voiceEngineFromEnv()).toBe("native");
    expect(logs.messages("WARNING")).toEqual([]);
  });

  test("pipedog and native name themselves", () => {
    setEnv({ EIDOLON_VOICE_ENGINE: "pipedog" });
    expect(voiceEngineFromEnv()).toBe("pipedog");
    setEnv({ EIDOLON_VOICE_ENGINE: "native" });
    expect(voiceEngineFromEnv()).toBe("native");
    expect(logs.messages("WARNING")).toEqual([]);
  });

  test("any other value runs native, and says so once", () => {
    setEnv({ EIDOLON_VOICE_ENGINE: "Pipedog" });
    expect(voiceEngineFromEnv()).toBe("native");
    expect(voiceEngineFromEnv()).toBe("native");
    expect(logs.messages("WARNING")).toEqual([
      "EIDOLON_VOICE_ENGINE='Pipedog' is neither pipedog nor native; calls run on native",
    ]);
  });

  test("createSignallingServer reads it once, as it is made", async () => {
    setEnv({ EIDOLON_VOICE_ENGINE: "pipdog" });
    const signalling = createSignallingServer({
      ice: { serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }) },
    });
    setEnv({ EIDOLON_VOICE_ENGINE: "nativ" });
    expect((await signalling.patch("not json")).status).toBe(400);
    expect(await signalling.offer({ allowed: true, body: null } as AllowedOffer)).toMatchObject({
      status: 400,
    });
    await signalling.close();
    expect(logs.messages("WARNING")).toEqual([
      "EIDOLON_VOICE_ENGINE='pipdog' is neither pipedog nor native; calls run on native",
    ]);
  });
});

describe("createSignallingServer", () => {
  /** Which transport's peer answered an offer to a server made under `engine`. */
  async function answeredBy(engine: string | undefined): Promise<string[]> {
    const built: string[] = [];
    const answer = { sdp: "v=0\r\n", type: "answer" };
    const spies = [
      spyOn(SmallWebRTCConnection.prototype, "initialize").mockImplementation(async function (
        this: SmallWebRTCConnection,
      ) {
        built.push("pipedog");
        (this as unknown as { _answer: unknown })._answer = answer;
      }),
      spyOn(Peer.prototype, "initialize").mockImplementation(async () => {
        built.push("webrtc");
      }),
      spyOn(Peer.prototype, "getAnswer").mockImplementation(function (this: Peer) {
        return { ...answer, pc_id: this.pcId };
      }),
    ];
    setEnv({ EIDOLON_VOICE_ENGINE: engine });
    const signalling = createSignallingServer({
      ice: { serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }) },
    });
    try {
      const offer = offered({ sdp: "v=0", type: "offer" });
      const result = await signalling.offer(offer);
      expect(result.status).toBe(200);
      // Both answer in the same shape.
      expect(Object.keys(result.body as object)).toEqual(["sdp", "type", "pc_id"]);
    } finally {
      for (const spy of spies) spy.mockRestore();
      await signalling.close();
    }
    return built;
  }

  test("under native, unset or not, every offer is a native call on @eidolon/webrtc's peers", async () => {
    expect(await answeredBy("native")).toEqual(["webrtc"]);
    expect(await answeredBy(undefined)).toEqual(["webrtc"]);
    expect(await answeredBy("")).toEqual(["webrtc"]);
  });

  test("under pipedog, every offer is a pipedog session on pipedog's", async () => {
    expect(await answeredBy("pipedog")).toEqual(["pipedog"]);
  });
});

describe("runNativeSafely", () => {
  function setup(overrides: Partial<CallDeps> = {}) {
    const transport = new FakeTransport();
    const turns: FakeTurn[] = [];
    const deps: CallDeps = {
      engine: { createMind: (): Mind => ({ async *stream() {} }) } as EngineDeps,
      runTurn: ((request: CallTurnRequest) => {
        const turn = new FakeTurn(request, `turn-${turns.length + 1}`);
        turns.push(turn);
        return turn.lines;
      }) as unknown as CallDeps["runTurn"],
      openStt: async () => new FakeStt(),
      openSpeech: () => new FakeSpeech(),
      openRealtime: async () => {
        throw new Error("no realtime here");
      },
      models: voiceModels(),
      about: BOT_ABOUT,
      clock: new FakeClock(0),
      ...overrides,
    };
    return { transport, turns, deps };
  }

  const admission = (
    token: string | null,
  ): Pick<AllowedOffer, "user" | "token" | "requestData"> => ({
    user: { mid: 7, uname: "Ken", face: null, isLoggedIn: true },
    token,
    requestData: { audioQuality: "medium" },
  });

  test("logs a session's start as pipedog does, and greets the viewer as the active persona", async () => {
    const s = setup();
    const running = runNativeSafely(s.transport, admission(null), s.deps);
    await until(() => s.transport.connected, 10_000);
    s.transport.messages.push({
      label: "rtvi-ai",
      type: "client-ready",
      id: "c1",
      data: { version: "2.3.0" },
    });
    await until(() => s.turns.length === 1);
    const request = (s.turns[0] as FakeTurn).request;
    const host = activePersona().id;
    expect(request.persona).toBe(host);
    expect(request.viewer).toEqual(admission(null).user);
    expect(request.kickoff).toBe(true);
    expect(request.chat.header).toMatchObject({ format: 1, participants: [host] });
    expect(request.usage).toEqual({ source: "call", session: request.chat.header.id });
    expect(s.transport.sent.map((m) => m.type)).toEqual(["bot-ready"]);

    s.transport.leave();
    await running;
    expect(s.transport.disconnects).toBe(0);
    const lines = logs.messages("INFO");
    expect(lines).toContain(
      `[bot] Session start without loginSyncToken; runner_args.body=${pyRepr({ audioQuality: "medium" })}`,
    );
    expect(lines.indexOf("Starting bot")).toBeGreaterThan(-1);
    expect(lines.indexOf("Client connected")).toBeGreaterThan(lines.indexOf("Starting bot"));
    expect(lines.at(-1)).toBe("Client disconnected");
  }, 15_000);

  test("a token's length is logged, never the token", async () => {
    const s = setup();
    const running = runNativeSafely(s.transport, admission("tök€n"), s.deps);
    await until(() => s.transport.connected, 10_000);
    s.transport.leave();
    await running;
    expect(logs.messages("INFO")).toContain("[bot] Session start with loginSyncToken (len=5)");
    expect(logs.records.some((r) => r.message.includes("tök€n"))).toBe(false);
  }, 15_000);

  test("a chat window in the request data is logged by its size, never its lines", async () => {
    const s = setup();
    const chat = { header: {}, events: [{ text: "我的秘密" }, { text: "another" }] };
    const running = runNativeSafely(
      s.transport,
      { ...admission(null), requestData: { audioQuality: "medium", chat } },
      s.deps,
    );
    await until(() => s.transport.connected, 10_000);
    s.transport.leave();
    await running;
    expect(logs.messages("INFO")).toContain(
      `[bot] Session start without loginSyncToken; runner_args.body=${pyRepr({ audioQuality: "medium", chat: "<chat: 2 events>" })}`,
    );
    expect(logs.records.some((r) => r.message.includes("我的秘密"))).toBe(false);
  }, 15_000);

  test("a call that can't start logs `Bot session failed:` and disconnects, never rejecting", async () => {
    const s = setup({
      openSpeech: () => {
        throw new Error("Fish Audio has no key: set FISH_API_KEY");
      },
    });
    await runNativeSafely(s.transport, admission(null), s.deps);
    await settle();
    expect(logs.messages("ERROR")).toEqual([
      "Bot session failed: Fish Audio has no key: set FISH_API_KEY",
    ]);
    expect(s.transport.disconnects).toBe(1);
    expect(s.transport.connected).toBe(false);
  });
});
