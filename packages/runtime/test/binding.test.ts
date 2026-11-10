// A call bound to a chat: seeded with it, reporting its lines, and run as the chat's persona while
// another is active. The pipeline runs for real on scripted STT, LLM and TTS; nothing leaves the
// process.
import "../../config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { AllowedOffer, UserContext } from "@eidolon/access";
import { activePersona, dataHome, resetSettings } from "@eidolon/config";
import type { ContextTurn } from "@eidolon/core";
import { MEM0_STORE_KEY } from "@eidolon/memory";
import { abortable } from "@pipedog/asyncio";
import {
  type Frame,
  InputAudioRawFrame,
  InputTransportMessageFrame,
  TranscriptionFrame,
  TTSAudioRawFrame,
  VADUserStartedSpeakingFrame,
  VADUserStoppedSpeakingFrame,
} from "@pipedog/core/frames/frames";
import type { LLMAssistantAggregator } from "@pipedog/core/processors/aggregators/llm_response_universal";
import { FrameDirection, FrameProcessor } from "@pipedog/core/processors/frame_processor";
import { TTSSettings } from "@pipedog/core/services/settings";
import { TTSService } from "@pipedog/core/services/tts_service";
import { FishAudioTTSService } from "@pipedog/fish/tts";
import { float32Tensor, type OnnxBackend, type OnnxTensor } from "@pipedog/onnx";
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";
import { SonioxSTTService } from "@pipedog/soniox/stt";
import { RTCPeerConnection } from "@pipedog/transport-smallwebrtc/rtc";
import { createLlm, createStt, createTts } from "../src/session/services.ts";
import {
  buildSession,
  type CallBinding,
  type CallClient,
  runBound,
  runSessionSafely,
  runTransportSession,
  type SessionDeps,
  type SessionMemory,
  type TranscriptLine,
} from "../src/session/session.ts";
import { createSignallingServerWith } from "../src/webrtc/signalling.ts";
import { captureLogs, FakeTransport, type LogCapture, setEnv, until } from "./support.ts";

const VIEWER: UserContext = { mid: 7, uname: "看客", face: null, isLoggedIn: true };
const ADMISSION = { user: VIEWER, token: null, requestData: null };

/** Silero never hears speech, so the test's VAD frames alone mark turns; Smart Turn ends each. */
const turnBackend: OnnxBackend = {
  name: "scripted-turns",
  createSession: async (model) => {
    const smartTurn = String(model).includes("smart-turn");
    return {
      inputNames: [],
      outputNames: smartTurn ? ["probs"] : ["output", "stateN"],
      run: async (): Promise<Record<string, OnnxTensor>> =>
        smartTurn
          ? { probs: float32Tensor(Float32Array.of(0.99), [1, 1]) }
          : {
              output: float32Tensor(Float32Array.of(0), [1, 1]),
              stateN: float32Tensor(new Float32Array(256), [2, 1, 128]),
            },
      dispose: async () => {},
    };
  },
};

/** Hears each utterance as its scripted transcript, finalized as the VAD stops it. */
class ScriptedStt extends FrameProcessor {
  readonly #transcripts: string[];
  readonly personas: string[] = [];

  constructor(transcripts: string[]) {
    super({ name: "stt" });
    this.#transcripts = transcripts;
  }

  override async processFrame(frame: Frame, direction: FrameDirection): Promise<void> {
    await super.processFrame(frame, direction);
    if (frame instanceof VADUserStoppedSpeakingFrame && direction === FrameDirection.DOWNSTREAM) {
      this.personas.push(activePersona().id);
      const text = this.#transcripts.shift() ?? "";
      const timestamp = new Date().toISOString();
      await this.pushFrame(
        new TranscriptionFrame({ text, userId: "", timestamp, finalized: true }),
      );
    }
    await this.pushFrame(frame, direction);
  }
}

/** Speaks each sentence as a beat of silence; `hold` never finishes until it is cut off. */
class ScriptedTts extends TTSService {
  readonly #hold: string | null;
  readonly spoken: { persona: string; text: string }[] = [];

  constructor(hold: string | null) {
    super({
      pushStartFrame: true,
      pushStopFrames: true,
      sampleRate: 24000,
      settings: new TTSSettings({ model: null, voice: null, language: null }),
    });
    this.#hold = hold;
  }

  override canGenerateMetrics(): boolean {
    return false;
  }

  override async *runTts(text: string, contextId: string): AsyncGenerator<Frame | null, void> {
    this.spoken.push({ persona: activePersona().id, text });
    if (text.trim() === this.#hold) await abortable(new Promise<never>(() => {}));
    const audio = new Uint8Array(960);
    yield new TTSAudioRawFrame({ audio, sampleRate: 24000, numChannels: 1, contextId });
  }
}

interface LlmRequest {
  readonly persona: string;
  readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
}

/** OpenRouter's service on a client that streams the scripted replies, one per request. */
function scriptedLlm(replies: string[][], requests: LlmRequest[]): SessionDeps["createLlm"] {
  const client = {
    chat: {
      completions: {
        create: async (body: { messages: LlmRequest["messages"] }) => {
          requests.push({ persona: activePersona().id, messages: structuredClone(body.messages) });
          const reply = replies.shift() ?? [];
          return (async function* () {
            for (const content of reply) yield { choices: [{ delta: { content } }] };
          })();
        },
      },
    },
  };
  class Scripted extends OpenRouterLLMService {
    override createClient(): any {
      return client;
    }
  }
  return (systemInstruction) =>
    new Scripted({
      apiKey: "test-key",
      settings: new OpenRouterLLMService.Settings({ systemInstruction }),
    });
}

interface Stored {
  readonly persona: string;
  readonly messages: unknown;
}

function scriptedDeps(parts: {
  stt: ScriptedStt;
  tts: ScriptedTts;
  llm: SessionDeps["createLlm"];
  stored: Stored[];
  seen: string[];
}): SessionDeps {
  const memory: SessionMemory = {
    onContext: async (turn: ContextTurn) => {
      parts.stored.push({ persona: activePersona().id, messages: turn.metadata[MEM0_STORE_KEY] });
    },
    errorMessage: () => "memory error",
    newestFirst: async () => {
      parts.seen.push(`memories:${activePersona().id}`);
      return [];
    },
  };
  return {
    isRealtime: () => false,
    createRealtime: () => {
      throw new Error("realtime is off");
    },
    createStt: () => parts.stt,
    createTts: () => parts.tts,
    createLlm: parts.llm,
    loadVoiceStyles: () => new Map(),
    createVoiceTool: () => null,
    voicePromptHint: () => "",
    createSelfieTool: () => null,
    selfiePromptHint: () => "",
    buildSystemInstruction: async () => {
      parts.seen.push(`prompt:${activePersona().id}`);
      return "persona prompt";
    },
    interruptedEmptyTurnPrompt: "再说一遍？",
    buildGreetingKickoff: () => {
      parts.seen.push(`kickoff:${activePersona().id}`);
      return "打个招呼";
    },
    dbPath: () => "/nowhere",
    dbPathExists: async () => false,
    openArchive: async () => {
      throw new Error("no archive");
    },
    openFacts: async () => {
      throw new Error("no facts");
    },
    retrievalGateFromEnv: () => null,
    isMemoryConfigured: () => true,
    createMemoryProvider: async () => memory,
    audioBackend: async () => turnBackend,
  };
}

function rtvi(type: string, data: unknown): InputTransportMessageFrame {
  return new InputTransportMessageFrame({
    message: { label: "rtvi-ai", type, id: crypto.randomUUID(), data },
  });
}

/** What the transport's input pushes as the viewer starts talking. */
async function startTalking(input: FrameProcessor): Promise<void> {
  await input.queueFrame(new VADUserStartedSpeakingFrame({ startSecs: 0.2 }));
  for (let i = 0; i < 10; i++) {
    const audio = new Uint8Array(640);
    await input.queueFrame(new InputAudioRawFrame({ audio, sampleRate: 16000, numChannels: 1 }));
  }
}

async function stopTalking(input: FrameProcessor): Promise<void> {
  await input.queueFrame(new VADUserStoppedSpeakingFrame({ stopSecs: 0.2 }));
}

const SEED = [
  { role: "user", content: "我养了一只叫团子的猫" },
  { role: "assistant", content: "团子这名字好可爱！" },
];

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  logs.restore();
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

type Line = TranscriptLine & { readonly persona: string };

/** A call on scripted services, with the client-ready message already in. */
async function call(
  options: (Omit<CallBinding, "onTranscript" | "onEnded"> & { readonly failing?: string }) | null,
) {
  const requests: LlmRequest[] = [];
  const stored: Stored[] = [];
  const seen: string[] = [];
  const lines: Line[] = [];
  const clients: CallClient[] = [];
  const stt = new ScriptedStt(["今天吃什么", "等一下"]);
  const tts = new ScriptedTts("第二句。");
  const replies = [["你好呀，", "又见面了。"], ["第一句。", "第二句。"], ["好的。"], ["收到。"]];
  const llm = scriptedLlm(replies, requests);
  const transport = new FakeTransport();
  const input = transport.input();
  const deps = scriptedDeps({ stt, tts, llm, stored, seen });
  let binding: CallBinding | undefined;
  if (options) {
    const { failing, ...bound } = options;
    binding = {
      ...bound,
      onTranscript: (line, client) => {
        if (client) clients.push(client);
        if (line.text === failing) throw new Error("the chat is gone");
        lines.push({ ...line, persona: activePersona().id });
      },
      onEnded: () => {},
    };
  }
  const done = runBound(binding, deps, (d) => runTransportSession(transport, ADMISSION, d));
  await until(() => logs.messages("DEBUG").some((m) => m.includes("started running")));
  // The client's ready message arrives as the transport pushes it, upstream to RTVI.
  await input.queueFrame(rtvi("client-ready", { version: "1.0.0" }), FrameDirection.UPSTREAM);
  await until(() => requests.length === 1);
  return {
    requests,
    stored,
    seen,
    lines,
    stt,
    tts,
    input,
    clients,
    /** The RTVI server messages the transport's output would have sent the browser. */
    serverMessages: () =>
      transport.sent.filter((m) => (m as { type?: unknown }).type === "server-message"),
    /** Her reply as the assistant aggregator holds it, before her turn stops. */
    held: () => (transport.output().next as LLMAssistantAggregator).aggregationString(),
    /** A transport callback, outside any persona scope, as werift's are. */
    hangUp: async () => {
      await transport.emit("on_client_disconnected");
      await done;
    },
  };
}

const KEYS = {
  SONIOX_API_KEY: "soniox-key",
  FISH_API_KEY: "fish-key",
  FISH_VOICE_ID: "env-voice",
  OPENROUTER_API_KEY: "openrouter-key",
  ...Object.fromEntries(
    [
      "SONIOX_MODEL",
      "FISH_MODEL",
      "OPENROUTER_MODEL",
      "STT_PROVIDER",
      "STT_MODEL",
      "LLM_PROVIDER",
      "LLM_MODEL",
      "TTS_PROVIDER",
      "TTS_MODEL",
      "TTS_VOICE_ID",
      "REALTIME_PROVIDER",
      "REALTIME_MODEL",
    ].map((name) => [name, undefined]),
  ),
};

describe("a call bound to a chat", () => {
  test("runs as her, opens on the chat, and reports each finished line, a cut-off one as spoken", async () => {
    expect(activePersona().id).toBe("milky-green");
    const c = await call({ persona: "bob", seedMessages: SEED });
    await until(() => c.lines.length === 1);
    expect(c.requests[0]?.messages).toEqual([
      { role: "system", content: "persona prompt" },
      ...SEED,
      { role: "user", content: "打个招呼" },
    ]);

    await startTalking(c.input);
    await stopTalking(c.input);
    await until(() => c.tts.spoken.some((s) => s.text.trim() === "第二句。"));
    await until(() => c.held() === "第一句。");
    // The viewer cuts her off mid-reply, then finishes what they were saying.
    await startTalking(c.input);
    await until(() => c.lines.length === 3);
    await stopTalking(c.input);
    await until(() => c.lines.length === 5);
    await c.input.queueFrame(
      rtvi("send-text", { content: "我打字说的", options: { run_immediately: true } }),
      FrameDirection.UPSTREAM,
    );
    await until(() => c.lines.length === 7);
    await c.hangUp();

    expect(c.lines).toEqual([
      { role: "assistant", text: "你好呀，又见面了。", interrupted: false, persona: "bob" },
      { role: "user", text: "今天吃什么", interrupted: false, persona: "bob" },
      { role: "assistant", text: "第一句。", interrupted: true, persona: "bob" },
      { role: "user", text: "等一下", interrupted: false, persona: "bob" },
      { role: "assistant", text: "好的。", interrupted: false, persona: "bob" },
      { role: "user", text: "我打字说的", interrupted: false, persona: "bob" },
      { role: "assistant", text: "收到。", interrupted: false, persona: "bob" },
    ]);
    // The context keeps what the lines say: her cut-off reply is its spoken part.
    expect(c.requests.at(-1)?.messages.slice(1)).toEqual([
      ...SEED,
      { role: "user", content: "打个招呼" },
      { role: "assistant", content: "你好呀，又见面了。" },
      { role: "user", content: "今天吃什么" },
      { role: "assistant", content: "第一句。" },
      { role: "user", content: "等一下" },
      { role: "assistant", content: "好的。" },
      { role: "user", content: "我打字说的" },
    ]);
    expect(new Set(c.requests.map((r) => r.persona))).toEqual(new Set(["bob"]));
    expect(new Set(c.tts.spoken.map((s) => s.persona))).toEqual(new Set(["bob"]));
    expect(new Set(c.stt.personas)).toEqual(new Set(["bob"]));
    expect(c.seen).toEqual(["prompt:bob", "memories:bob", "kickoff:bob"]);
    // Mem0 stores what was said on the call, never the chat it was seeded with.
    expect(c.stored.map((s) => s.persona)).toEqual(["bob", "bob", "bob", "bob"]);
    expect(c.stored[0]?.messages).toEqual([{ role: "user", content: "打个招呼" }]);
    for (const { messages } of c.stored) {
      for (const message of SEED) expect(messages).not.toContainEqual(message);
    }
    expect(activePersona().id).toBe("milky-green");
    expect(logs.messages("WARNING")).toEqual([]);
    expect(logs.messages("ERROR")).toEqual([]);
  }, 15000);

  test("each line comes with the call's browser, which a server message reaches until it hangs up", async () => {
    const c = await call({ persona: "bob", seedMessages: [] });
    await startTalking(c.input);
    await stopTalking(c.input);
    await until(() => c.lines.length === 2);
    const [client] = c.clients;
    expect([c.clients.length, new Set(c.clients).size]).toEqual([2, 1]);
    await client?.sendServerMessage({ type: "chat-line", event: { seq: 4 } });
    await until(() => c.serverMessages().length === 1);
    expect(c.serverMessages()).toEqual([
      { label: "rtvi-ai", type: "server-message", data: { type: "chat-line", event: { seq: 4 } } },
    ]);
    await c.hangUp();
    await client?.sendServerMessage({ type: "chat-line", event: { seq: 5 } });
    expect(c.serverMessages()).toHaveLength(1);
    expect(logs.messages("ERROR")).toEqual([]);
  }, 15000);

  test("a line its caller fails to record is logged, and the lines after it still arrive", async () => {
    const c = await call({ persona: "bob", seedMessages: [], failing: "我打字说的" });
    await until(() => c.lines.length === 1);
    for (const content of ["我打字说的", "再打一句"]) {
      const typed = rtvi("send-text", { content, options: { run_immediately: false } });
      await c.input.queueFrame(typed, FrameDirection.UPSTREAM);
    }
    await until(() => c.lines.length === 2);
    await c.hangUp();
    expect(c.lines.map((line) => line.text)).toEqual(["你好呀，又见面了。", "再打一句"]);
    expect(logs.messages("ERROR")).toEqual(["Could not report a call line: the chat is gone"]);
  }, 15000);

  test("without a binding, a call is today's: the active persona, no seed, Mem0 given the context", async () => {
    const c = await call(null);
    await startTalking(c.input);
    await stopTalking(c.input);
    await until(() => c.requests.length === 2);
    await c.hangUp();
    expect(c.requests[0]?.messages).toEqual([
      { role: "system", content: "persona prompt" },
      { role: "user", content: "打个招呼" },
    ]);
    expect(c.requests.map((r) => r.persona)).toEqual(["milky-green", "milky-green"]);
    expect(c.seen).toEqual(["prompt:milky-green", "memories:milky-green", "kickoff:milky-green"]);
    expect(c.stored.map((s) => s.messages)).toEqual([undefined, undefined]);
    expect(c.lines).toEqual([]);
  }, 15000);

  test("without a binding, the session runs on the deps it was given", () => {
    const deps = {} as SessionDeps;
    let given: SessionDeps | null = null;
    expect(
      runBound(undefined, deps, (d) => {
        given = d;
        return activePersona().id;
      }),
    ).toBe("milky-green");
    expect(given === deps).toBe(true);
  });

  test("her hearing, mind and voice are her own while another persona is active", async () => {
    const restore = setEnv(KEYS);
    try {
      write(
        "personas/bob/persona.yaml",
        "identity:\n  name: Bob\nhearing:\n  model: stt-bob\nmind:\n  model: bob/chat\nvoice:\n  voiceId: bob-voice\n",
      );
      const roles = (processors: readonly FrameProcessor[]) => {
        const settings = (role: abstract new (...args: any[]) => FrameProcessor) =>
          (processors.find((p) => p instanceof role) as any)._settings;
        return {
          hearing: settings(SonioxSTTService).model,
          mind: settings(OpenRouterLLMService).model,
          voice: settings(FishAudioTTSService).voice,
        };
      };
      const scripted = scriptedDeps({
        stt: new ScriptedStt([]),
        tts: new ScriptedTts(null),
        llm: scriptedLlm([], []),
        stored: [],
        seen: [],
      });
      const deps = { ...scripted, createStt, createTts, createLlm };
      const build = (binding: CallBinding | undefined) =>
        runBound(binding, deps, (d) => buildSession(new FakeTransport(), VIEWER, d));
      const bob = await build({
        persona: "bob",
        seedMessages: [],
        onTranscript: () => {},
        onEnded: () => {},
      });
      const active = await build(undefined);
      expect(roles(bob.processors)).toEqual({
        hearing: "stt-bob",
        mind: "bob/chat",
        voice: "bob-voice",
      });
      expect(roles(active.processors)).toEqual({
        hearing: "stt-rt-v5",
        mind: "~google/gemini-flash-latest",
        voice: "env-voice",
      });
    } finally {
      restore();
    }
  });

  // werift never offers a loopback address as a host candidate, so the peers need another interface.
  const hasLanAddress = Object.values(networkInterfaces()).some((addresses) =>
    addresses?.some((a) => a.family === "IPv4" && !a.internal),
  );

  test.skipIf(!hasLanAddress)(
    "over a real peer, werift's callbacks run nothing outside her scope, and the end is reported once",
    async () => {
      const requests: LlmRequest[] = [];
      const seen: string[] = [];
      const lines: Line[] = [];
      const ends: { end: string; after: number }[] = [];
      const deps = scriptedDeps({
        stt: new ScriptedStt([]),
        tts: new ScriptedTts(null),
        llm: scriptedLlm([["你好呀。"]], requests),
        stored: [],
        seen,
      });
      const sessions: Promise<void>[] = [];
      const server = createSignallingServerWith(
        { ice: { serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }) } },
        {
          startSession: (connection, admission, binding) => {
            const session = runSessionSafely(connection, admission, deps, binding);
            sessions.push(session);
            return session;
          },
          candidates: {
            dropUnreachableCandidates: (sdp) => ({ sdp, dropped: [] }),
            candidateReachable: () => true,
            scrubRelayRelatedAddresses: (sdp) => sdp,
          },
        },
      );
      const peer = new RTCPeerConnection({ iceServers: [] });
      try {
        peer.addTransceiver("audio", { direction: "sendrecv" });
        const channel = peer.createDataChannel("chat");
        await peer.setLocalDescription(await peer.createOffer());
        const admission: AllowedOffer = {
          allowed: true,
          ...ADMISSION,
          body: { sdp: peer.localDescription?.sdp, type: "offer" },
          opusBitrateBps: 96000,
          clientIp: "127.0.0.1",
          quota: null,
        };
        const result = await server.offer(admission, {
          persona: "bob",
          seedMessages: SEED,
          onTranscript: (line) => lines.push({ ...line, persona: activePersona().id }),
          onEnded: (end) => ends.push({ end, after: lines.length }),
        });
        const answer = result.body as { sdp: string };
        await peer.setRemoteDescription({ sdp: answer.sdp, type: "answer" } as never);
        await until(() => channel.readyState === "open", 8000);
        // Arrives on werift's data channel callback, with no persona scope of its own.
        channel.send(
          JSON.stringify({
            label: "rtvi-ai",
            type: "client-ready",
            id: "1",
            data: { version: "1.0.0" },
          }),
        );
        await until(() => lines.length === 1, 8000);
        // The server hangs up, and the session ends on the connection's own closed callback.
        await server.close();
        await sessions[0];
      } finally {
        await server.close();
        await peer.close();
      }
      expect(lines).toEqual([
        { role: "assistant", text: "你好呀。", interrupted: false, persona: "bob" },
      ]);
      expect(requests.map((r) => r.persona)).toEqual(["bob"]);
      expect(requests[0]?.messages.slice(1, 3)).toEqual(SEED);
      expect(seen).toEqual(["prompt:bob", "memories:bob", "kickoff:bob"]);
      expect(ends).toEqual([{ end: "hangup", after: 1 }]);
    },
    20000,
  );
});
