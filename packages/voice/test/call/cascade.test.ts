// A whole call on a fake transport, fake hearing and voice roles and scripted turns: what it opens
// and closes, how it ends, the logs runtime's status reads, and the call's usage scope reaching
// what the transport's audio bills. runVoiceCall runs the real Ear on the real models.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { consoleSink, logger } from "@eidolon/config";
import type { EngineDeps } from "@eidolon/engine";
import { setUsageSink, type UsageRecord } from "@eidolon/providers";
import { type Ear, runCascadeCall } from "../../src/call/cascade.ts";
import { memoryCallLog } from "../../src/call/log.ts";
import { runVoiceCall, warmVoiceModels } from "../../src/index.ts";
import type { CallDeps, CallPlan, EarEvent } from "../../src/types.ts";
import { FakeClock } from "../input/clock.ts";
import { SILERO_MODEL, SMART_TURN_MODEL } from "../input/speech.ts";
import {
  ABOUT,
  FakeSpeech,
  FakeStt,
  FakeTransport,
  FakeTurn,
  HEADER,
  HOST,
  settle,
  VIEWER,
} from "./harness.ts";

let logs: string[];
beforeEach(() => {
  logs = [];
  logger.setSink((record) => logs.push(record.message));
});
afterEach(() => {
  logger.setSink(consoleSink);
  setUsageSink(null);
});

function setup(
  o: {
    readonly greet?: boolean;
    readonly openStt?: CallDeps["openStt"];
    readonly createMind?: EngineDeps["createMind"];
  } = {},
) {
  const transport = new FakeTransport();
  const stt = new FakeStt();
  const speech = new FakeSpeech();
  const clock = new FakeClock(0);
  const turns: FakeTurn[] = [];
  const runTurn = (request: ConstructorParameters<typeof FakeTurn>[0]) => {
    const turn = new FakeTurn(request, `turn-${turns.length + 1}`);
    turns.push(turn);
    return turn.lines;
  };
  const deps: CallDeps = {
    engine: { createMind: o.createMind ?? (() => ({ async *stream() {} })) } as EngineDeps,
    runTurn: runTurn as unknown as CallDeps["runTurn"],
    openStt: o.openStt ?? (async () => stt),
    openSpeech: () => speech,
    openRealtime: async () => {
      throw new Error("no realtime here");
    },
    models: { silero: SILERO_MODEL, smartTurn: SMART_TURN_MODEL },
    about: ABOUT,
    clock,
  };
  const plan: CallPlan = {
    id: "call-7",
    host: HOST,
    viewer: VIEWER,
    log: memoryCallLog(HEADER),
    greet: o.greet ?? false,
    realtime: false,
  };
  const heard: { post: (event: EarEvent) => void } = { post: () => {} };
  const ear: Ear = async (audio, sttStream, post, signal) => {
    heard.post = post;
    for await (const pcm of audio) {
      if (signal.aborted) return;
      sttStream.send(pcm);
    }
  };
  return { transport, stt, speech, clock, turns, deps, plan, ear, heard };
}

describe("runCascadeCall", () => {
  test("from the client's connection to its leaving", async () => {
    const s = setup({ greet: true });
    const shutdown = new AbortController();
    const running = runCascadeCall(s.transport, s.plan, s.deps, shutdown.signal, { ear: s.ear });
    await settle();
    expect(s.transport.connected).toBe(true);
    expect(s.transport.source?.rate).toBe(24_000);
    expect(logs).toContain("Client connected");

    s.transport.rtvi("client-ready", { version: "2.3.0" });
    await settle();
    expect(s.transport.types).toEqual(["bot-ready"]);
    expect(s.turns).toHaveLength(1);
    const greeting = s.turns[0] as FakeTurn;
    expect(greeting.request.kickoff).toBe(true);

    greeting.round("欢迎。");
    await settle();
    s.heard.post({ type: "user-started" });
    await settle();
    s.transport.leave();
    expect(await running).toBe("client");
    expect(greeting.request.signal.aborted).toBe(true);
    expect(s.transport.disconnects).toBe(0);
    expect(s.stt.closed).toBe(true);
    expect(s.speech.closed).toBe(true);
    expect(logs.at(-1)).toBe("Client disconnected");
    expect(s.transport.types).toEqual([
      "bot-ready",
      "bot-llm-started",
      "bot-llm-text",
      "bot-llm-stopped",
      "bot-transcription",
      "bot-tts-started",
      "user-started-speaking",
      "bot-interrupted",
      "bot-tts-stopped",
    ]);
  });

  test("an idle call ends after 300 s and tells the client it left", async () => {
    const s = setup();
    const running = runCascadeCall(s.transport, s.plan, s.deps, new AbortController().signal, {
      ear: s.ear,
    });
    await settle();
    s.clock.advance(300_000);
    expect(await running).toBe("idle");
    expect(s.transport.disconnects).toBe(1);
    expect(logs.at(-1)).toBe("Call ended: idle");
  });

  test("a fatal hearing failure ends the call", async () => {
    const s = setup();
    const failing: Ear = async () => {
      throw new Error("VAD exploded");
    };
    const running = runCascadeCall(s.transport, s.plan, s.deps, new AbortController().signal, {
      ear: failing,
    });
    expect(await running).toBe("error");
    expect(s.transport.types).toEqual(["error"]);
    expect(s.transport.sent[0]?.data).toEqual({ error: "VAD exploded", fatal: false });
    expect(s.transport.disconnects).toBe(1);
  });
});

describe("runVoiceCall", () => {
  test("a call that can't start logs it as runtime's status reads it, and disconnects", async () => {
    const s = setup({
      openStt: async () => {
        throw new Error("Soniox needs an API key");
      },
    });
    const reason = await runVoiceCall(s.transport, s.plan, s.deps, new AbortController().signal);
    expect(reason).toBe("error");
    expect(logs).toContain("Bot session failed: Soniox needs an API key");
    expect(s.transport.disconnects).toBe(1);
    expect(s.transport.connected).toBe(false);
    expect(s.speech.closed).toBe(true);
  });

  test("a mind role with no key fails the call before anything connects, as pipedog's session does", async () => {
    let dialled = 0;
    const s = setup({
      createMind: () => {
        throw new Error("OpenRouter needs an API key");
      },
      openStt: async () => {
        dialled++;
        throw new Error("the recognizer was dialled");
      },
    });
    const reason = await runVoiceCall(s.transport, s.plan, s.deps, new AbortController().signal);
    expect(reason).toBe("error");
    expect(logs).toContain("Bot session failed: OpenRouter needs an API key");
    expect(dialled).toBe(0);
    expect(s.transport.connected).toBe(false);
    expect(s.transport.disconnects).toBe(1);
    expect(s.speech.closed).toBe(true);
  });

  test("a realtime plan runs as a realtime call, which can't start without a realtime role", async () => {
    const s = setup();
    const plan = { ...s.plan, realtime: true };
    expect(await runVoiceCall(s.transport, plan, s.deps, new AbortController().signal)).toBe(
      "error",
    );
    expect(logs.some((l) => l.startsWith("Bot session failed: "))).toBe(true);
  });

  test("audio the transport delivers is billed to the call, and the server's shutdown ends it", async () => {
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    const s = setup();
    const shutdown = new AbortController();
    const running = runVoiceCall(s.transport, s.plan, s.deps, shutdown.signal);
    for (let i = 0; i < 50 && !s.transport.connected; i++) await Bun.sleep(5);
    // A transport's callback runs outside the call's scope.
    setTimeout(() => s.transport.audioIn.push(new Int16Array(320)), 0);
    for (let i = 0; i < 50 && s.stt.samples === 0; i++) await Bun.sleep(5);
    expect(s.stt.samples).toBe(320);
    expect(records).toMatchObject([{ role: "hearing", source: "call", session: "call-7" }]);
    shutdown.abort();
    expect(await running).toBe("shutdown");
    expect(s.transport.disconnects).toBe(1);
    expect(logs.at(-1)).toBe("Call ended: shutdown");
  });
});

describe("warmVoiceModels", () => {
  test("loads both models, and rejects when one can't load", async () => {
    await warmVoiceModels({ silero: SILERO_MODEL, smartTurn: SMART_TURN_MODEL });
    await expect(
      warmVoiceModels({ silero: SILERO_MODEL, smartTurn: "/nonexistent/smart-turn.onnx" }),
    ).rejects.toThrow();
  });
});
