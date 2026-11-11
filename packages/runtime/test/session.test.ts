import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AllowedOffer, UserContext } from "@eidolon/access";
import { activePersona } from "@eidolon/config";
import type { ContextProvider, LlmTool } from "@eidolon/core";
import { SileroVADAnalyzer } from "@pipedog/audio-silero";
import { LocalSmartTurnAnalyzerV3 } from "@pipedog/audio-smart-turn";
import { ToolsSchema } from "@pipedog/core/adapters/schemas/tools_schema";
import { LLMRunFrame } from "@pipedog/core/frames/frames";
import { Pipeline } from "@pipedog/core/pipeline/pipeline";
import { PipelineWorker } from "@pipedog/core/pipeline/worker";
import { LLMContext } from "@pipedog/core/processors/aggregators/llm_context";
import type { FrameProcessor } from "@pipedog/core/processors/frame_processor";
import type { OnnxBackend } from "@pipedog/onnx";
import { OpenRouterLLMService } from "@pipedog/openrouter/llm";
import { SmallWebRTCConnection } from "@pipedog/transport-smallwebrtc/connection";
import { ContextProviderProcessor, RetrievalGateProcessor } from "../src/adapters/context.ts";
import { LaplaceRTVIProcessor } from "../src/rtvi.ts";
import {
  type ArchiveProvider,
  assembleProcessors,
  buildSession,
  installGreeting,
  type PipelineParts,
  runSessionSafely,
  runTransportSession,
  type Session,
  type SessionDeps,
  type SessionMemory,
} from "../src/session/session.ts";
import { captureLogs, FakeTransport, type LogCapture, PassThrough, until } from "./support.ts";

// INTERRUPTED_EMPTY_TURN_PROMPT, byte for byte.
const INTERRUPTED_PROMPT =
  "你刚才说话的时候，好像说了句什么，但没听清。" +
  "你的话在那儿被打断了，对话里只留下ta听到的部分，也可能一句都没听到。" +
  "用一句话自然地请ta再说一遍；" +
  "如果你刚才问了问题，ta可能没听到，就顺带再问一次。";

const ANONYMOUS: UserContext = { mid: null, uname: null, face: null, isLoggedIn: false };
const VIEWER: UserContext = { mid: 12345, uname: "奶糖花A", face: null, isLoggedIn: true };

const fakeBackend: OnnxBackend = {
  name: "fake",
  createSession: async () => ({
    inputNames: [],
    outputNames: [],
    run: async () => ({}),
    dispose: async () => {},
  }),
};

function tool(name: string): LlmTool {
  return {
    schema: { name, description: name, properties: {}, required: [] },
    cancelOnInterruption: true,
    timeoutSecs: null,
    run: async () => ({ ok: true }),
  };
}

function provider(label: string): ContextProvider {
  return { onContext: async () => {}, errorMessage: () => `${label} error` };
}

function archive(recall: LlmTool | null = null): ArchiveProvider {
  return { ...provider("StreamArchiveService"), recallTool: async () => recall };
}

function memory(newestFirst: SessionMemory["newestFirst"] = async () => []): SessionMemory {
  return { ...provider("Mem0"), newestFirst };
}

interface Calls {
  prompts: Parameters<SessionDeps["buildSystemInstruction"]>[0][];
  gates: number;
  memoryUsers: string[];
  opened: string[];
}

function fakeDeps(overrides: Partial<SessionDeps> = {}): { deps: SessionDeps; calls: Calls } {
  const calls: Calls = { prompts: [], gates: 0, memoryUsers: [], opened: [] };
  const deps: SessionDeps = {
    isRealtime: () => false,
    createRealtime: () => {
      throw new Error("realtime is off");
    },
    createStt: () => new PassThrough("stt"),
    createTts: () => new PassThrough("tts"),
    createLlm: (systemInstruction) =>
      new OpenRouterLLMService({
        apiKey: "test-key",
        settings: new OpenRouterLLMService.Settings({ systemInstruction }),
      }),
    loadVoiceStyles: () => new Map([["default", "voice-default"]]),
    createVoiceTool: () => null,
    voicePromptHint: () => "VOICE HINT",
    createSelfieTool: () => null,
    selfiePromptHint: () => "SELFIE HINT",
    buildSystemInstruction: async (input) => {
      calls.prompts.push(input);
      return "persona prompt";
    },
    interruptedEmptyTurnPrompt: INTERRUPTED_PROMPT,
    buildGreetingKickoff: (memories) =>
      memories.length === 0 ? "plain kickoff" : `kickoff with ${memories.length}`,
    dbPath: () => "/repo/data/lancedb",
    dbPathExists: async () => false,
    openArchive: async (dbPath) => {
      calls.opened.push(`archive:${dbPath}`);
      return archive();
    },
    openFacts: async (dbPath) => {
      calls.opened.push(`facts:${dbPath}`);
      return provider("PersonaFactsService");
    },
    retrievalGateFromEnv: () => {
      calls.gates++;
      return { attach: () => {} };
    },
    isMemoryConfigured: () => false,
    createMemoryProvider: async ({ userId }) => {
      calls.memoryUsers.push(userId);
      return memory();
    },
    audioBackend: async () => fakeBackend,
    ...overrides,
  };
  return { deps, calls };
}

function toolNames(context: LLMContext): string[] {
  return context.tools instanceof ToolsSchema ? context.tools.standardTools.map((s) => s.name) : [];
}

const SESSION_LINES =
  /^(\[bot\] Session start|Starting bot|Stream archive disabled|Mem0 |Persona facts disabled|Client (dis)?connected)/;

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(async () => {
  // Silero's model load settles a tick after a session is built; keep its line captured.
  await new Promise((resolve) => setTimeout(resolve, 10));
  logs.restore();
});

function sessionLines(): string[] {
  return logs.records.filter((r) => SESSION_LINES.test(r.message)).map((r) => r.message);
}

describe("assembleProcessors", () => {
  test("keeps bot.py's order for every combination of optional processors", () => {
    const fixed = Object.fromEntries(
      ["input", "stt", "user", "llm", "tts", "output", "assistant"].map((n) => [
        n,
        new PassThrough(n),
      ]),
    ) as Record<string, FrameProcessor>;
    const optional = ["gate", "memory", "archive", "facts"] as const;
    for (let mask = 0; mask < 16; mask++) {
      const present = optional.filter((_, i) => mask & (1 << i));
      const parts = { ...fixed } as unknown as Record<string, FrameProcessor | null>;
      for (const name of optional)
        parts[name] = present.includes(name) ? new PassThrough(name) : null;
      const order = assembleProcessors(parts as unknown as PipelineParts).map((p) => p.name);
      expect(order).toEqual([
        "input",
        "stt",
        "user",
        ...present,
        "llm",
        "tts",
        "output",
        "assistant",
      ]);
    }
  });
});

describe("buildSession", () => {
  test("no index and an anonymous viewer: no RAG, no gate, no memory, no tools", async () => {
    const { deps, calls } = fakeDeps();
    const transport = new FakeTransport();
    const session = await buildSession(transport, ANONYMOUS, deps);
    expect(sessionLines()).toEqual([
      "Stream archive disabled: no LanceDB index at /repo/data/lancedb. Run `bun run laplace-ingest-streams --persona milky-green` to build it.",
      "Mem0 skipped: anonymous viewer (no loginSyncToken / validation failed)",
      "Persona facts disabled: no LanceDB index at /repo/data/lancedb. Run `bun run laplace-ingest-facts --persona milky-green` to build it.",
    ]);
    expect(calls.gates).toBe(0);
    expect(calls.opened).toEqual([]);
    expect(session.memory).toBeNull();
    expect(session.processors.map((p) => p.name)).toEqual([
      "FakeInput",
      "stt",
      session.processors[2]?.name,
      session.processors[3]?.name,
      "tts",
      "FakeOutput",
      session.processors[6]?.name,
    ]);
    expect(session.processors[0]).toBe(transport.input());
    expect(session.processors[5]).toBe(transport.output());
    expect(session.processors[3]).toBeInstanceOf(OpenRouterLLMService);
    expect(session.context.tools instanceof ToolsSchema).toBe(false);
    expect(calls.prompts).toEqual([{ viewer: ANONYMOUS, voiceHint: "", selfieHint: "" }]);
  });

  test("everything on: gate, memory, archive and facts in that order, before the LLM", async () => {
    const { deps, calls } = fakeDeps({
      dbPathExists: async () => true,
      isMemoryConfigured: () => true,
    });
    const session = await buildSession(new FakeTransport(), VIEWER, deps);
    const [input, stt, user, gate, mem, arch, facts, llm, tts, output, assistant] =
      session.processors;
    expect([input?.name, stt?.name, tts?.name, output?.name]).toEqual([
      "FakeInput",
      "stt",
      "tts",
      "FakeOutput",
    ]);
    expect(user?.constructor.name).toBe("LLMUserAggregator");
    expect(assistant?.constructor.name).toBe("LLMAssistantAggregator");
    expect(gate).toBeInstanceOf(RetrievalGateProcessor);
    for (const p of [mem, arch, facts]) expect(p).toBeInstanceOf(ContextProviderProcessor);
    expect(gate?.name).toMatch(/^RetrievalGate#\d+$/);
    expect(mem?.name).toMatch(/^LaplaceMem0MemoryService#\d+$/);
    expect(arch?.name).toMatch(/^StreamArchiveService#\d+$/);
    expect(facts?.name).toMatch(/^PersonaFactsService#\d+$/);
    expect(llm).toBeInstanceOf(OpenRouterLLMService);
    expect(session.processors).toHaveLength(11);
    expect(calls.memoryUsers).toEqual(["12345"]);
    expect(calls.opened).toEqual(["archive:/repo/data/lancedb", "facts:/repo/data/lancedb"]);
    expect(calls.gates).toBe(1);
    expect(sessionLines()).toEqual(["Mem0 long-term memory enabled for user_id=12345 ('奶糖花A')"]);
  });

  test("with no chat bound, a session is today's: the same processors, no messages, no listeners", async () => {
    const { deps } = fakeDeps({ dbPathExists: async () => true, isMemoryConfigured: () => true });
    const bare = await buildSession(new FakeTransport(), VIEWER, deps);
    const bound = await buildSession(new FakeTransport(), VIEWER, {
      ...deps,
      seedMessages: [{ role: "user", content: "早" }],
      onTranscript: () => {},
    });
    const classes = (s: Session) => s.processors.map((p) => p.constructor.name);
    expect(classes(bare)).toEqual([
      "PassThrough",
      "PassThrough",
      "LLMUserAggregator",
      "RetrievalGateProcessor",
      "ContextProviderProcessor",
      "ContextProviderProcessor",
      "ContextProviderProcessor",
      "OpenRouterLLMService",
      "PassThrough",
      "PassThrough",
      "LLMAssistantAggregator",
    ]);
    expect(classes(bound)).toEqual(classes(bare));
    expect(bare.context.getMessages()).toEqual([]);
    expect(bound.context.getMessages()).toEqual([{ role: "user", content: "早" }]);
    const listeners = (s: Session) =>
      [
        [s.processors[2], "on_user_turn_message_added"],
        [s.processors[10], "on_assistant_turn_stopped"],
      ].map(([p, event]) => (p as any)._eventHandlers.get(event).handlers.length);
    expect(listeners(bare)).toEqual([0, 0]);
    expect(listeners(bound)).toEqual([1, 1]);
    const observers = (s: Session) =>
      (s.worker as any)._observer._observers.map((o: object) => o.constructor.name);
    expect(observers(bare)).not.toContain("TypedLines");
    expect(observers(bound)).toEqual(["TypedLines", ...observers(bare)]);
  });

  test("a logged-in viewer without a vector store skips Mem0", async () => {
    const { deps, calls } = fakeDeps();
    const session = await buildSession(new FakeTransport(), VIEWER, deps);
    expect(session.memory).toBeNull();
    expect(calls.memoryUsers).toEqual([]);
    expect(sessionLines()).toContain(
      "Mem0 skipped: MEM0_QDRANT_HOST is unset, so there is no vector store",
    );
  });

  test("a memory store that can't be reached leaves the session without memory", async () => {
    const { deps } = fakeDeps({
      isMemoryConfigured: () => true,
      createMemoryProvider: async () => {
        throw new Error("qdrant down");
      },
    });
    const session = await buildSession(new FakeTransport(), VIEWER, deps);
    expect(session.memory).toBeNull();
    expect(session.processors).toHaveLength(7);
    expect(logs.messages("WARNING")).toEqual([
      "Mem0 unavailable, continuing without memory: qdrant down",
    ]);
  });

  test("an archive that won't open is disabled; facts alone still get the gate", async () => {
    const { deps, calls } = fakeDeps({
      dbPathExists: async () => true,
      openArchive: async () => {
        throw new Error("lancedb broken");
      },
    });
    const session = await buildSession(new FakeTransport(), ANONYMOUS, deps);
    expect(logs.messages("WARNING")).toEqual(["Stream archive disabled: lancedb broken"]);
    expect(calls.gates).toBe(1);
    expect(session.processors[3]).toBeInstanceOf(RetrievalGateProcessor);
    expect(session.processors[4]?.name).toMatch(/^PersonaFactsService#\d+$/);
  });

  test("an archive alone gets the gate; no gate factory without either tier", async () => {
    let factsOpened = 0;
    const { deps, calls } = fakeDeps({
      dbPathExists: async () => true,
      openFacts: async () => {
        factsOpened++;
        throw new Error("no facts");
      },
    });
    await buildSession(new FakeTransport(), ANONYMOUS, deps);
    expect(factsOpened).toBe(1);
    expect(calls.gates).toBe(1);
  });

  test("tools register voice, selfie, then recall; the prompt hints follow the tools", async () => {
    const { deps, calls } = fakeDeps({
      dbPathExists: async () => true,
      createVoiceTool: () => tool("change_voice_style"),
      createSelfieTool: () => tool("take_selfie"),
      openArchive: async () => archive(tool("recall_streams")),
    });
    const session = await buildSession(new FakeTransport(), VIEWER, deps);
    expect(toolNames(session.context)).toEqual([
      "change_voice_style",
      "take_selfie",
      "recall_streams",
    ]);
    expect(calls.prompts).toEqual([
      { viewer: VIEWER, voiceHint: "VOICE HINT", selfieHint: "SELFIE HINT" },
    ]);
    const llm = session.processors.find((p) => p instanceof OpenRouterLLMService) as any;
    expect(llm._settings.systemInstruction).toBe("persona prompt");
    expect([...llm._functions.keys()]).toEqual([
      "change_voice_style",
      "take_selfie",
      "recall_streams",
    ]);
  });

  test("voice and recall only: two tools in order, no selfie hint", async () => {
    const { deps, calls } = fakeDeps({
      dbPathExists: async () => true,
      createVoiceTool: () => tool("change_voice_style"),
      openArchive: async () => archive(tool("recall_streams")),
    });
    const session = await buildSession(new FakeTransport(), ANONYMOUS, deps);
    expect(toolNames(session.context)).toEqual(["change_voice_style", "recall_streams"]);
    expect(calls.prompts[0]?.selfieHint).toBe("");
    expect(calls.prompts[0]?.voiceHint).toBe("VOICE HINT");
  });

  test("an archive that can't offer recall registers nothing", async () => {
    const { deps } = fakeDeps({ dbPathExists: async () => true });
    const session = await buildSession(new FakeTransport(), ANONYMOUS, deps);
    expect(session.tools.size).toBe(0);
    expect(session.context.tools instanceof ToolsSchema).toBe(false);
  });

  test("a realtime model hears and speaks for itself: no STT, TTS, VAD or voice switching", async () => {
    let built = "";
    const { deps, calls } = fakeDeps({
      dbPathExists: async () => true,
      isRealtime: () => true,
      createRealtime: (systemInstruction) => {
        built = systemInstruction;
        return new OpenRouterLLMService({
          apiKey: "test-key",
          settings: new OpenRouterLLMService.Settings({ systemInstruction }),
        });
      },
      createStt: () => {
        throw new Error("no STT under a realtime model");
      },
      createTts: () => {
        throw new Error("no TTS under a realtime model");
      },
      createVoiceTool: () => tool("change_voice_style"),
      createSelfieTool: () => tool("take_selfie"),
      openArchive: async () => archive(tool("recall_streams")),
      audioBackend: async () => {
        throw new Error("no local VAD under a realtime model");
      },
    });
    const session = await buildSession(new FakeTransport(), VIEWER, deps);
    expect(built).toBe("persona prompt");
    expect(calls.prompts).toEqual([
      { viewer: VIEWER, voiceHint: "", selfieHint: "SELFIE HINT", realtime: true },
    ]);
    expect(toolNames(session.context)).toEqual(["take_selfie", "recall_streams"]);
    const names = session.processors.map((p) => p.name);
    expect(names).not.toContain("stt");
    expect(names).not.toContain("tts");
    const params = (session.processors[1] as any)._params;
    expect(params.vadAnalyzer ?? null).toBeNull();
    expect(params.emptyUserTurn.interruptedPrompt).toBe(INTERRUPTED_PROMPT);
  });

  test("the user aggregator: Silero VAD, explicit Smart Turn, the Chinese empty-turn prompt", async () => {
    const { deps } = fakeDeps();
    const session = await buildSession(new FakeTransport(), ANONYMOUS, deps);
    const params = (session.processors[2] as any)._params;
    expect(params.vadAnalyzer).toBeInstanceOf(SileroVADAnalyzer);
    expect(params.emptyUserTurn.interruptedPrompt).toBe(INTERRUPTED_PROMPT);
    expect(params.emptyUserTurn.idlePrompt).toBeNull();
    expect(params.emptyUserTurn.maxConsecutiveRecoveries).toBe(1);
    expect(params.userIdleTimeout).toBe(0);
    expect(params.userTurnStrategies.stop[0]._turnAnalyzer).toBeInstanceOf(
      LocalSmartTurnAnalyzerV3,
    );
  });

  test("the worker keeps Pipecat's idle cancel and turns metrics on", async () => {
    const { deps } = fakeDeps();
    const { worker } = await buildSession(new FakeTransport(), ANONYMOUS, deps);
    const w = worker as any;
    expect(w._idleTimeoutSecs).toBe(300);
    expect(w._cancelOnIdleTimeout).toBe(true);
    expect(w._cancelRunnerOnIdleTimeout).toBe(true);
    expect(worker.params.enableMetrics).toBe(true);
    expect(worker.params.enableUsageMetrics).toBe(true);
    expect(worker.params.audioInSampleRate).toBe(16000);
    expect(worker.params.audioOutSampleRate).toBe(24000);
    expect(worker.rtvi).toBeInstanceOf(LaplaceRTVIProcessor);
  });
});

describe("greeting", () => {
  function greetingWorker() {
    const worker = new PipelineWorker(new Pipeline([new PassThrough("p")]), {
      rtviProcessor: new LaplaceRTVIProcessor(),
    });
    let botReady = 0;
    worker.rtvi.setBotReady = async () => {
      botReady++;
    };
    const queued: unknown[][] = [];
    spyOn(worker, "queueFrames").mockImplementation(async (frames: any) => {
      queued.push([...frames]);
    });
    const fire = async () => {
      await (worker.rtvi as any)._callEventHandler("on_client_ready", worker.rtvi);
      await until(() => queued.length > 0);
    };
    return { worker, queued, fire, botReady: () => botReady };
  }

  const kickoff = (memories: readonly { readonly memory?: unknown }[]) =>
    memories.length === 0 ? "plain" : `with ${memories.map((m) => String(m.memory)).join(",")}`;

  test("without memory: the plain kickoff as a user message, then one LLMRunFrame", async () => {
    const { worker, queued, fire, botReady } = greetingWorker();
    const context = new LLMContext();
    installGreeting(worker, context, null, kickoff);
    await fire();
    expect(context.getMessages()).toEqual([{ role: "user", content: "plain" }]);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toHaveLength(1);
    expect(queued[0]?.[0]).toBeInstanceOf(LLMRunFrame);
    expect(botReady()).toBe(1);
  });

  test("with memory: newest-first memories feed the kickoff", async () => {
    const { worker, fire } = greetingWorker();
    const context = new LLMContext();
    installGreeting(
      worker,
      context,
      memory(async () => [{ memory: "a" }, { memory: "b" }]),
      kickoff,
    );
    await fire();
    expect(context.getMessages()).toEqual([{ role: "user", content: "with a,b" }]);
  });

  test("a memory store failure warns and falls back to the plain kickoff", async () => {
    const { worker, fire } = greetingWorker();
    const context = new LLMContext();
    installGreeting(
      worker,
      context,
      memory(async () => {
        throw new Error("qdrant down");
      }),
      kickoff,
    );
    await fire();
    expect(context.getMessages()).toEqual([{ role: "user", content: "plain" }]);
    expect(logs.messages("WARNING")).toEqual([
      "Could not load Mem0 memories for greeting: qdrant down",
    ]);
  });
});

describe("runTransportSession", () => {
  function offer(token: string | null, requestData: Record<string, unknown> | null) {
    return { user: token ? VIEWER : ANONYMOUS, token, requestData };
  }

  test("runs until the client disconnects, which cancels the worker once", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("no network in tests");
    }) as never);
    const cancel = spyOn(PipelineWorker.prototype, "cancel");
    try {
      const transport = new FakeTransport();
      const { deps } = fakeDeps();
      const done = runTransportSession(transport, offer(null, { audioQuality: "medium" }), deps);
      await until(() => logs.messages("DEBUG").some((m) => m.includes("started running")));
      await transport.emit("on_client_connected");
      await transport.emit("on_client_disconnected");
      await done;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(sessionLines()).toEqual([
        "[bot] Session start without loginSyncToken; runner_args.body={'audioQuality': 'medium'}",
        "Starting bot",
        "Stream archive disabled: no LanceDB index at /repo/data/lancedb. Run `bun run laplace-ingest-streams --persona milky-green` to build it.",
        "Mem0 skipped: anonymous viewer (no loginSyncToken / validation failed)",
        "Persona facts disabled: no LanceDB index at /repo/data/lancedb. Run `bun run laplace-ingest-facts --persona milky-green` to build it.",
        "Client connected",
        "Client disconnected",
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      cancel.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("a token is logged by length only", async () => {
    const { deps } = fakeDeps({
      createStt: () => {
        throw new Error("stop here");
      },
    });
    await expect(
      runTransportSession(new FakeTransport(), offer("tok-12", { loginSyncToken: "tok-12" }), deps),
    ).rejects.toThrow("stop here");
    expect(sessionLines()).toEqual([
      "[bot] Session start with loginSyncToken (len=6)",
      "Starting bot",
    ]);
  });

  test("a chat in the request body is logged by its size alone, every other field as it came", async () => {
    const { deps } = fakeDeps({
      createStt: () => {
        throw new Error("stop here");
      },
    });
    const events = [
      { seq: 1, type: "message", speaker: { kind: "user" }, text: "我家住在幸福路3号" },
      { seq: 2, type: "message", speaker: { kind: "persona", id: "milky-green" }, text: "记住了" },
    ];
    const bodies = [
      { audioQuality: "high", chat: { header: { id: "c-1" }, events }, persona: "milky-green" },
      { chat: "我家住在幸福路3号" },
      { chat: { header: { id: "c-1" }, events: "我家住在幸福路3号" } },
    ];
    for (const body of bodies) {
      await expect(
        runTransportSession(new FakeTransport(), offer(null, body), deps),
      ).rejects.toThrow("stop here");
    }
    expect(sessionLines().filter((line) => line.startsWith("[bot] Session start"))).toEqual([
      "[bot] Session start without loginSyncToken; runner_args.body={'audioQuality': 'high', 'chat': '<chat: 2 events>', 'persona': 'milky-green'}",
      "[bot] Session start without loginSyncToken; runner_args.body={'chat': '<chat: not a window>'}",
      "[bot] Session start without loginSyncToken; runner_args.body={'chat': '<chat: not a window>'}",
    ]);
  });

  test("an empty request body logs Python's None", async () => {
    const { deps } = fakeDeps({
      createStt: () => {
        throw new Error("stop here");
      },
    });
    await expect(
      runTransportSession(new FakeTransport(), offer(null, null), deps),
    ).rejects.toThrow();
    expect(sessionLines()[0]).toBe(
      "[bot] Session start without loginSyncToken; runner_args.body=None",
    );
  });
});

describe("runSessionSafely", () => {
  test("a setup failure is logged, the answered peer is closed, and nothing rejects", async () => {
    const connection = new SmallWebRTCConnection();
    const disconnect = spyOn(connection, "disconnect");
    const { deps } = fakeDeps({
      createStt: () => {
        throw new Error("SONIOX_API_KEY environment variable is required");
      },
    });
    const admission: AllowedOffer = {
      allowed: true,
      user: ANONYMOUS,
      token: null,
      body: { sdp: "x", type: "offer" },
      requestData: null,
      opusBitrateBps: 96000,
      clientIp: "203.0.113.1",
      quota: null,
    };
    await runSessionSafely(connection, admission, deps);
    expect(disconnect).toHaveBeenCalledTimes(1);
    await until(() => logs.messages("DEBUG").includes("Client connection closed."));
    const failure = logs.records.find((r) => r.level === "ERROR");
    expect(failure?.message).toBe(
      "Bot session failed: SONIOX_API_KEY environment variable is required",
    );
    expect((failure?.error as Error | undefined)?.message).toBe(
      "SONIOX_API_KEY environment variable is required",
    );
  });
  test("a disconnect that throws during cleanup still never rejects", async () => {
    const connection = new SmallWebRTCConnection();
    spyOn(connection, "disconnect").mockRejectedValue(new Error("already closed"));
    const { deps } = fakeDeps({
      createStt: () => {
        throw new Error("boom");
      },
    });
    const admission: AllowedOffer = {
      allowed: true,
      user: ANONYMOUS,
      token: null,
      body: { sdp: "x", type: "offer" },
      requestData: null,
      opusBitrateBps: 96000,
      clientIp: "203.0.113.1",
      quota: null,
    };
    await runSessionSafely(connection, admission, deps);
    expect(logs.messages("WARNING")).toContain(
      "Closing the failed session's connection failed: already closed",
    );
  });

  const failedAdmission: AllowedOffer = {
    allowed: true,
    user: ANONYMOUS,
    token: null,
    body: { sdp: "x", type: "offer" },
    requestData: null,
    opusBitrateBps: 96000,
    clientIp: "203.0.113.1",
    quota: null,
  };

  test("bound, a setup failure built as her ends the call once, as an error, after closing the peer", async () => {
    const connection = new SmallWebRTCConnection();
    const order: string[] = [];
    spyOn(connection, "disconnect").mockImplementation(async () => {
      order.push("disconnect");
    });
    const { deps } = fakeDeps({
      createStt: () => {
        order.push(`build:${activePersona().id}`);
        throw new Error("boom");
      },
    });
    await runSessionSafely(connection, failedAdmission, deps, {
      persona: "bob",
      seedMessages: [],
      onTranscript: () => {},
      onEnded: (end) => order.push(`ended:${end}`),
    });
    expect(order).toEqual(["build:bob", "disconnect", "ended:error"]);
    expect(activePersona().id).toBe("milky-green");
  });

  test("an end its binding fails to record is logged, and nothing rejects", async () => {
    const connection = new SmallWebRTCConnection();
    spyOn(connection, "disconnect").mockResolvedValue(undefined);
    const { deps } = fakeDeps({
      createStt: () => {
        throw new Error("boom");
      },
    });
    await runSessionSafely(connection, failedAdmission, deps, {
      persona: "bob",
      seedMessages: [],
      onTranscript: () => {},
      onEnded: () => {
        throw new Error("the chat is gone");
      },
    });
    expect(logs.messages("ERROR")).toEqual([
      "Bot session failed: boom",
      "Could not report the call's end: the chat is gone",
    ]);
  });
});
