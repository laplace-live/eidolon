// The switch between the engines: how EIDOLON_VOICE_ENGINE reads, which offers the native engine
// sends to pipedog and why, and a native call's start, on a fake transport with fake providers and
// the real hearing models.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AllowedOffer } from "@eidolon/access";
import { activePersona, pyRepr } from "@eidolon/config";
import type { CallTurnRequest, EngineDeps, Mind } from "@eidolon/engine";
import { PROVIDERS } from "@eidolon/providers";
import type { CallDeps } from "@eidolon/voice";
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
import {
  nativeCanRun,
  runNativeSafely,
  sessionStarter,
  voiceEngineFromEnv,
} from "../../src/native/engine.ts";
import { BOT_ABOUT } from "../../src/rtvi.ts";
import { captureLogs, type LogCapture, setEnv, until } from "../support.ts";

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

const voiceLines = () => logs.messages("INFO").filter((m) => m.startsWith("[voice]"));

describe("voiceEngineFromEnv", () => {
  test("unset and blank are pipedog, without a word", () => {
    expect(voiceEngineFromEnv()).toBe("pipedog");
    setEnv({ EIDOLON_VOICE_ENGINE: "" });
    expect(voiceEngineFromEnv()).toBe("pipedog");
    expect(logs.messages("WARNING")).toEqual([]);
  });

  test("pipedog and native name themselves", () => {
    setEnv({ EIDOLON_VOICE_ENGINE: "pipedog" });
    expect(voiceEngineFromEnv()).toBe("pipedog");
    setEnv({ EIDOLON_VOICE_ENGINE: "native" });
    expect(voiceEngineFromEnv()).toBe("native");
    expect(logs.messages("WARNING")).toEqual([]);
  });

  test("any other value runs pipedog, and says so once", () => {
    setEnv({ EIDOLON_VOICE_ENGINE: "Native" });
    expect(voiceEngineFromEnv()).toBe("pipedog");
    expect(voiceEngineFromEnv()).toBe("pipedog");
    expect(logs.messages("WARNING")).toEqual([
      "EIDOLON_VOICE_ENGINE='Native' is neither pipedog nor native; calls run on pipedog",
    ]);
  });

  test("createSignallingServer reads it once, as it is made", async () => {
    setEnv({ EIDOLON_VOICE_ENGINE: "nativ" });
    const signalling = createSignallingServer({
      ice: { serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }) },
    });
    setEnv({ EIDOLON_VOICE_ENGINE: "pipdog" });
    expect((await signalling.patch("not json")).status).toBe(400);
    expect(await signalling.offer({ allowed: true, body: null } as AllowedOffer)).toMatchObject({
      status: 400,
    });
    await signalling.close();
    expect(logs.messages("WARNING")).toEqual([
      "EIDOLON_VOICE_ENGINE='nativ' is neither pipedog nor native; calls run on pipedog",
    ]);
  });
});

describe("nativeCanRun", () => {
  test("a persona who hears, thinks and speaks through three roles runs natively, quietly", () => {
    expect(nativeCanRun()).toBeNull();
    expect(voiceLines()).toEqual([]);
  });

  test("a realtime persona's calls run natively, quietly, whatever her hearing and voice", () => {
    setEnv({ REALTIME_PROVIDER: "openai", STT_PROVIDER: "openrouter", TTS_PROVIDER: "openrouter" });
    expect(nativeCanRun()).toBeNull();
    setEnv({ REALTIME_PROVIDER: "xai" });
    expect(nativeCanRun()).toBeNull();
    expect(voiceLines()).toEqual([]);
  });

  test("every provider the catalog offers for realtime has a native client", () => {
    const realtime = PROVIDERS.filter((p) => p.offers.realtime !== undefined).map((p) => p.id);
    expect(realtime.length).toBeGreaterThan(0);
    for (const id of realtime) {
      setEnv({ REALTIME_PROVIDER: id });
      expect([id, nativeCanRun()]).toEqual([id, null]);
    }
  });

  test("settings it can't read send the call to pipedog, which fails it as it does today", () => {
    setEnv({ REALTIME_PROVIDER: "soniox" });
    const reason = nativeCanRun();
    expect(reason).toContain("Soniox offers no realtime voice model (REALTIME_PROVIDER)");
    expect(voiceLines()).toEqual([`[voice] This call runs on pipedog: ${reason}`]);
  });

  test("every provider the catalog offers for hearing or voice has a native client", () => {
    const hearing = PROVIDERS.filter((p) => p.offers.stt !== undefined).map((p) => p.id);
    const voice = PROVIDERS.filter((p) => p.offers.tts !== undefined).map((p) => p.id);
    expect(hearing.length).toBeGreaterThan(0);
    expect(voice.length).toBeGreaterThan(0);
    for (const id of hearing) {
      setEnv({ STT_PROVIDER: id });
      expect([id, nativeCanRun()]).toEqual([id, null]);
    }
    setEnv({ STT_PROVIDER: undefined });
    for (const id of voice) {
      setEnv({ TTS_PROVIDER: id });
      expect([id, nativeCanRun()]).toEqual([id, null]);
    }
  });
});

describe("sessionStarter", () => {
  const offer = { allowed: true } as AllowedOffer;

  function sessions() {
    const started: string[] = [];
    return {
      started,
      pipedog: async (connection: string) => void started.push(`pipedog ${connection}`),
      native: async (connection: string) => void started.push(`native ${connection}`),
    };
  }

  test("under pipedog, an offer starts pipedog's session itself and asks nothing", async () => {
    const s = sessions();
    // Settings that would stop a native call: pipedog never looks.
    setEnv({ REALTIME_PROVIDER: "soniox" });
    const start = sessionStarter("pipedog", s);
    expect(start).toBe(s.pipedog);
    await start("pc-1", offer);
    expect(s.started).toEqual(["pipedog pc-1"]);
    expect(voiceLines()).toEqual([]);
  });

  test("under native, a call inside a chat runs natively with its binding, quietly", async () => {
    const started: string[] = [];
    const start = sessionStarter<string, { readonly persona: string }>("native", {
      pipedog: async (connection, _admission, binding) =>
        void started.push(`pipedog ${connection} ${binding?.persona}`),
      native: async (connection, _admission, binding) =>
        void started.push(`native ${connection} ${binding?.persona}`),
    });
    await start("pc-1", offer, { persona: "bob" });
    await start("pc-2", offer);
    expect(started).toEqual(["native pc-1 bob", "native pc-2 undefined"]);
    expect(voiceLines()).toEqual([]);
  });

  test("under native, each offer runs natively unless its persona can't yet", async () => {
    const s = sessions();
    const start = sessionStarter("native", s);
    await start("pc-1", offer);
    setEnv({ REALTIME_PROVIDER: "xai" });
    await start("pc-2", offer);
    setEnv({ REALTIME_PROVIDER: "soniox" });
    await start("pc-3", offer);
    setEnv({ REALTIME_PROVIDER: undefined });
    await start("pc-4", offer);
    expect(s.started).toEqual(["native pc-1", "native pc-2", "pipedog pc-3", "native pc-4"]);
    expect(voiceLines()).toEqual([
      expect.stringContaining(
        "[voice] This call runs on pipedog: Soniox offers no realtime voice model",
      ),
    ]);
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
