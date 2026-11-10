import "../../config/test/isolated-guard.ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserContext } from "@eidolon/access";
import { CHAT_FORMAT, type ChatEventDraft, stampEvents } from "@eidolon/chat";
import {
  activePersona,
  consoleSink,
  DEFAULT_PERSONA,
  dataHome,
  type LogLevel,
  type LogRecord,
  logger,
} from "@eidolon/config";
import { RECALL_HINT, RECALL_PREFIX, RECALL_TOOL_NAME } from "@eidolon/context";
import type { ContextProvider, LlmTool, TurnGate } from "@eidolon/core";
import {
  type ArchiveProvider,
  lastSelection,
  type MemoryProvider,
  type PartsDeps,
  personaParts,
} from "../src/parts.ts";
import type { TurnRequest } from "../src/types.ts";

const PERSONA = "alice";

function chatOf(id: string, drafts: readonly ChatEventDraft[] = []): TurnRequest["chat"] {
  return {
    header: { format: CHAT_FORMAT, id, createdAt: 0, participants: [PERSONA] },
    events: stampEvents(drafts, 0, 1000),
  };
}

const CHAT = chatOf("0190f5c8-0000-7000-8000-000000000001");
const VIEWER: UserContext = { mid: 0, uname: "Ken", face: null, isLoggedIn: true };
const ANONYMOUS: UserContext = { mid: null, uname: null, face: null, isLoggedIn: false };

beforeAll(() => {
  const dir = join(dataHome(), "personas", PERSONA);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "persona.yaml"), "identity:\n  name: Alice\n");
});
afterAll(() => {
  rmSync(join(dataHome(), "personas", PERSONA), { recursive: true, force: true });
});

const logs: LogRecord[] = [];
function messages(level: LogLevel): string[] {
  return logs.filter((record) => record.level === level).map((record) => record.message);
}
beforeEach(() => {
  logger.setSink((record) => logs.push(record));
});
afterEach(() => {
  logs.length = 0;
  logger.setSink(consoleSink);
});

function tool(name: string): LlmTool {
  return {
    schema: { name, description: name, properties: {}, required: [] },
    cancelOnInterruption: true,
    timeoutSecs: null,
    run: async () => ({}),
  };
}

const provider = (): ContextProvider => ({ onContext: async () => {}, errorMessage: () => "" });

function fake(overrides: Partial<PartsDeps> = {}) {
  const selfie = tool("take_selfie");
  const recall = tool("recall_streams");
  const voice = tool("change_voice_style");
  const styles = new Map([
    ["default", "v-default"],
    ["gentle", "v-gentle"],
  ]);
  const archive: ArchiveProvider = {
    ...provider(),
    recallTool: async () => recall,
    resumeSelection: async () => {},
  };
  const facts = provider();
  const memory: MemoryProvider = { ...provider(), newestFirst: async () => [{ memory: "喜欢猫" }] };
  const gate: TurnGate = { attach: () => {} };
  const calls = {
    selfie: 0,
    styles: 0,
    archive: [] as string[],
    facts: [] as string[],
    gate: 0,
    memory: [] as string[],
    instructions: [] as unknown[],
  };
  let generation = 0;
  const deps: PartsDeps = {
    createSelfieTool: () => {
      calls.selfie++;
      return selfie;
    },
    selfiePromptHint: () => "SELFIE HINT",
    loadVoiceStyles: () => {
      calls.styles++;
      return styles;
    },
    createVoiceTool: (loaded) => (loaded === styles ? voice : null),
    voicePromptHint: (loaded) => (loaded === styles ? "VOICE HINT" : ""),
    buildSystemInstruction: async (input) => {
      calls.instructions.push(input);
      return `SYSTEM ${calls.instructions.length} for ${activePersona().id}`;
    },
    dbPath: () => `/index/${activePersona().id}`,
    dbPathExists: async () => true,
    openArchive: async (path) => {
      calls.archive.push(path);
      return archive;
    },
    openFacts: async (path) => {
      calls.facts.push(path);
      return facts;
    },
    retrievalGateFromEnv: () => {
      calls.gate++;
      return gate;
    },
    isMemoryConfigured: () => true,
    createMemoryProvider: async ({ userId }) => {
      calls.memory.push(userId);
      return memory;
    },
    settingsGeneration: () => generation,
    ...overrides,
  };
  return {
    deps,
    calls,
    parts: { selfie, recall, voice, archive, facts, memory, gate },
    bump: () => {
      generation++;
    },
  };
}

describe("personaParts", () => {
  test("builds what a call builds, as the persona", async () => {
    const { deps, calls, parts } = fake();
    const built = await personaParts(deps)(PERSONA, VIEWER, CHAT);
    expect(built.systemInstruction).toBe(`SYSTEM 1 for ${PERSONA}`);
    expect(calls.instructions).toEqual([
      { viewer: VIEWER, voiceHint: "", selfieHint: "SELFIE HINT" },
    ]);
    expect(built.providers).toEqual([
      { label: "LaplaceMem0MemoryService", provider: parts.memory },
      { label: "StreamArchiveService", provider: parts.archive },
      { label: "PersonaFactsService", provider: parts.facts },
    ]);
    expect(built.gate).toBe(parts.gate);
    expect(built.tools).toEqual([parts.selfie, parts.recall]);
    expect(calls.archive).toEqual([`/index/${PERSONA}`]);
    expect(calls.memory).toEqual(["0"]);
    expect(await built.memories()).toEqual([{ memory: "喜欢猫" }]);
  });

  test("opens once per persona and settings generation, and rebuilds the instruction each turn", async () => {
    const { deps, calls, bump } = fake();
    const parts = personaParts(deps);
    const first = await parts(PERSONA, VIEWER, CHAT);
    const second = await parts(PERSONA, VIEWER, CHAT);
    expect(second.systemInstruction).not.toBe(first.systemInstruction);
    expect(second.providers).toEqual(first.providers);
    expect([calls.selfie, calls.archive.length, calls.facts.length, calls.gate]).toEqual([
      1, 1, 1, 1,
    ]);
    expect(calls.memory).toEqual(["0"]);

    await parts(DEFAULT_PERSONA, VIEWER, CHAT);
    expect(calls.archive).toEqual([`/index/${PERSONA}`, `/index/${DEFAULT_PERSONA}`]);

    bump();
    await parts(PERSONA, VIEWER, CHAT);
    expect(calls.archive).toEqual([
      `/index/${PERSONA}`,
      `/index/${DEFAULT_PERSONA}`,
      `/index/${PERSONA}`,
    ]);
    expect([calls.selfie, calls.gate, calls.memory.length]).toEqual([3, 3, 3]);
  });

  test("names a group chat's other personas in each turn's instruction", async () => {
    const { deps, calls } = fake();
    const parts = personaParts(deps);
    const others = ["露比"];
    await parts(PERSONA, VIEWER, CHAT, { others });
    await parts(PERSONA, VIEWER, CHAT, { others: [] });
    expect(calls.instructions).toEqual([
      { viewer: VIEWER, voiceHint: "", selfieHint: "SELFIE HINT", participants: others },
      { viewer: VIEWER, voiceHint: "", selfieHint: "SELFIE HINT" },
    ]);
    expect(calls.archive).toHaveLength(1);
  });

  test("a voice message's variant adds her voice-style tool first and its hint, as a call's", async () => {
    const { deps, calls, parts: made, bump } = fake();
    const parts = personaParts(deps);
    const text = await parts(PERSONA, VIEWER, CHAT);
    expect(calls.styles).toBe(0);
    const voice = await parts(PERSONA, VIEWER, CHAT, { voice: true });
    const again = await parts(PERSONA, VIEWER, CHAT, { voice: true });
    expect(text.tools).toEqual([made.selfie, made.recall]);
    expect(voice.tools).toEqual([made.voice, made.selfie, made.recall]);
    expect(again.tools).toEqual(voice.tools);
    expect(calls.instructions).toEqual([
      { viewer: VIEWER, voiceHint: "", selfieHint: "SELFIE HINT" },
      { viewer: VIEWER, voiceHint: "VOICE HINT", selfieHint: "SELFIE HINT" },
      { viewer: VIEWER, voiceHint: "VOICE HINT", selfieHint: "SELFIE HINT" },
    ]);
    // Her styles are read once per settings generation, and her providers are the text turns'.
    expect(calls.styles).toBe(1);
    expect(voice.providers).toEqual(text.providers);
    expect((await parts(PERSONA, VIEWER, CHAT)).tools).toEqual([made.selfie, made.recall]);
    bump();
    await parts(PERSONA, VIEWER, CHAT, { voice: true });
    expect(calls.styles).toBe(2);
  });

  test("a voice message offers no voice-style tool or hint while she has one voice", async () => {
    const { deps, calls } = fake({ createVoiceTool: () => null });
    const built = await personaParts(deps)(PERSONA, VIEWER, CHAT, { voice: true });
    expect(built.tools.map((t) => t.schema.name)).toEqual(["take_selfie", "recall_streams"]);
    expect(calls.instructions).toEqual([
      { viewer: VIEWER, voiceHint: "", selfieHint: "SELFIE HINT" },
    ]);
  });

  test("opens a chat's own, so no chat's providers see another's turns", async () => {
    const { deps, calls } = fake();
    const parts = personaParts(deps);
    await parts(PERSONA, VIEWER, CHAT);
    await parts(PERSONA, VIEWER, chatOf("other"));
    await parts(PERSONA, VIEWER, CHAT);
    expect([calls.archive.length, calls.facts.length, calls.gate, calls.memory.length]).toEqual([
      2, 2, 2, 2,
    ]);
  });

  test("a chat key keeps apart chats that share an id", async () => {
    const { deps, calls } = fake();
    const parts = personaParts(deps);
    const id = CHAT.header.id;
    await parts(PERSONA, VIEWER, CHAT, { chatKey: `mid:0/${id}` });
    await parts(PERSONA, ANONYMOUS, CHAT, { chatKey: `ip:203.0.113.9/${id}` });
    await parts(PERSONA, VIEWER, CHAT, { chatKey: `mid:0/${id}` });
    expect(calls.archive).toHaveLength(2);
    await parts(PERSONA, VIEWER, CHAT);
    expect(calls.archive).toHaveLength(3);
  });

  test("keeps the 32 chats used last", async () => {
    const { deps, calls } = fake();
    const parts = personaParts(deps);
    for (let n = 0; n <= 32; n++) await parts(PERSONA, VIEWER, chatOf(`chat ${n}`));
    await parts(PERSONA, VIEWER, chatOf("chat 32"));
    expect(calls.archive).toHaveLength(33);
    await parts(PERSONA, VIEWER, chatOf("chat 0"));
    expect(calls.archive).toHaveLength(34);
  });

  test("shares one open between turns that start together", async () => {
    const { deps, calls } = fake();
    const parts = personaParts(deps);
    await Promise.all([parts(PERSONA, VIEWER, CHAT), parts(PERSONA, VIEWER, CHAT)]);
    expect([calls.archive.length, calls.facts.length, calls.memory.length]).toEqual([1, 1, 1]);
  });

  test("leaves out take_selfie's hint and the recall tool when there are none", async () => {
    const { deps, calls } = fake({
      createSelfieTool: () => null,
      openArchive: async () => ({
        ...provider(),
        recallTool: async () => null,
        resumeSelection: async () => {},
      }),
    });
    const built = await personaParts(deps)(PERSONA, VIEWER, CHAT);
    expect(built.tools).toEqual([]);
    expect(calls.instructions).toEqual([{ viewer: VIEWER, voiceHint: "", selfieHint: "" }]);
  });

  test("tries a missing index again next turn, saying so once", async () => {
    let exists = false;
    const { deps, calls, parts: made } = fake({ dbPathExists: async () => exists });
    const parts = personaParts(deps);
    for (let i = 0; i < 2; i++) {
      const built = await parts(PERSONA, VIEWER, CHAT);
      expect(built.providers.map((p) => p.label)).toEqual(["LaplaceMem0MemoryService"]);
      expect(built.gate).toBeNull();
    }
    expect(calls.gate).toBe(0);
    expect(messages("INFO").filter((line) => line.includes("no LanceDB index"))).toEqual([
      `Stream archive disabled: no LanceDB index at /index/${PERSONA}. Run \`bun run laplace-ingest-streams --persona ${PERSONA}\` to build it.`,
      `Persona facts disabled: no LanceDB index at /index/${PERSONA}. Run \`bun run laplace-ingest-facts --persona ${PERSONA}\` to build it.`,
    ]);

    exists = true;
    const built = await parts(PERSONA, VIEWER, CHAT);
    expect(built.providers).toHaveLength(3);
    expect(built.gate).toBe(made.gate);
    expect(built.tools).toEqual([made.selfie, made.recall]);
  });

  test("tries an index that failed to open again next turn, saying so once", async () => {
    let fail = true;
    const { deps, parts: made } = fake({
      openFacts: async () => {
        if (fail) throw new Error("corrupt table");
        return made.facts;
      },
    });
    const parts = personaParts(deps);
    for (let i = 0; i < 2; i++) {
      expect((await parts(PERSONA, VIEWER, CHAT)).providers).toHaveLength(2);
    }
    expect(messages("WARNING")).toEqual(["Persona facts disabled: corrupt table"]);
    fail = false;
    expect((await parts(PERSONA, VIEWER, CHAT)).providers).toHaveLength(3);
  });

  test("skips Mem0 for an anonymous viewer and without a vector store, saying so once", async () => {
    const anonymous = fake();
    const parts = personaParts(anonymous.deps);
    for (let i = 0; i < 2; i++) {
      const built = await parts(PERSONA, ANONYMOUS, CHAT);
      expect(built.providers.map((p) => p.label)).toEqual([
        "StreamArchiveService",
        "PersonaFactsService",
      ]);
      expect(await built.memories()).toEqual([]);
    }
    expect(anonymous.calls.memory).toEqual([]);

    const off = fake({ isMemoryConfigured: () => false });
    const offParts = personaParts(off.deps);
    await offParts(PERSONA, VIEWER, CHAT);
    await offParts(PERSONA, VIEWER, CHAT);
    expect(off.calls.memory).toEqual([]);
    expect(messages("INFO").filter((line) => line.startsWith("Mem0 skipped"))).toEqual([
      "Mem0 skipped: anonymous viewer",
      "Mem0 skipped: MEM0_QDRANT_HOST is unset, so there is no vector store",
    ]);
  });

  test("tries Mem0 again a minute after Qdrant was down, saying so once", async () => {
    let down = true;
    const {
      deps,
      calls,
      parts: made,
    } = fake({
      createMemoryProvider: async ({ userId }) => {
        calls.memory.push(userId);
        if (down) throw new Error("ECONNREFUSED");
        return made.memory;
      },
    });
    const parts = personaParts(deps);
    const withoutMemory = async () => {
      const built = await parts(PERSONA, VIEWER, CHAT);
      expect(built.providers.map((p) => p.label)).not.toContain("LaplaceMem0MemoryService");
    };
    try {
      setSystemTime(new Date(0));
      await withoutMemory();
      down = false;
      setSystemTime(new Date(59_999));
      await withoutMemory();
      expect(calls.memory).toEqual(["0"]);

      down = true;
      setSystemTime(new Date(60_000));
      await withoutMemory();
      expect(messages("WARNING")).toEqual([
        "Mem0 unavailable, continuing without memory: ECONNREFUSED",
      ]);

      down = false;
      setSystemTime(new Date(120_000));
      const back = await parts(PERSONA, VIEWER, CHAT);
      expect(back.providers[0]).toEqual({
        label: "LaplaceMem0MemoryService",
        provider: made.memory,
      });
      await parts(PERSONA, VIEWER, CHAT);
      expect(calls.memory).toEqual(["0", "0", "0"]);
    } finally {
      setSystemTime();
    }
  });
});

describe("an archive opened on a chat under way", () => {
  const recall = (turn: string, result: Record<string, unknown>): ChatEventDraft[] => [
    {
      type: "tool-call",
      persona: PERSONA,
      turn,
      callId: "c1",
      name: RECALL_TOOL_NAME,
      arguments: {},
    },
    { type: "tool-result", persona: PERSONA, turn, callId: "c1", result },
  ];
  const block = (turn: string, content: string): ChatEventDraft => ({
    type: "context",
    persona: PERSONA,
    turn,
    position: 1,
    role: "system",
    content,
  });

  test("takes up her last recall_streams selection, once", async () => {
    const resumed: (readonly string[])[] = [];
    const { deps, parts: made } = fake();
    const archive: ArchiveProvider = {
      ...made.archive,
      resumeSelection: async (ids) => {
        resumed.push(ids);
      },
    };
    const parts = personaParts({ ...deps, openArchive: async () => archive });
    const log = chatOf(CHAT.header.id, recall("t1", { content: "…", broadcast_ids: ["b1", "b2"] }));
    await parts(PERSONA, VIEWER, log);
    await parts(PERSONA, VIEWER, log);
    expect(resumed).toEqual([["b1", "b2"]]);
  });

  test("keeps the archive when the selection can't be taken up", async () => {
    const { deps, parts: made } = fake();
    const archive: ArchiveProvider = {
      ...made.archive,
      resumeSelection: async () => {
        throw new Error("catalog unreadable");
      },
    };
    const parts = personaParts({ ...deps, openArchive: async () => archive });
    const log = chatOf(CHAT.header.id, recall("t1", { content: "…", broadcast_ids: ["b1"] }));
    expect((await parts(PERSONA, VIEWER, log)).providers).toContainEqual({
      label: "StreamArchiveService",
      provider: archive,
    });
    expect(messages("WARNING")).toEqual([
      "Stream archive: the chat's last recall selection is lost: catalog unreadable",
    ]);
  });

  test("reads only her own successful calls, and none a recall block came after", () => {
    const of = (...drafts: ChatEventDraft[]) => lastSelection(chatOf("c", drafts).events, PERSONA);
    const picked = recall("t1", { content: "…", broadcast_ids: ["b1"] });
    expect(of()).toBeNull();
    expect(of(...picked)).toEqual(["b1"]);
    expect(of(...picked, ...recall("t2", { error: "直播查询未完成" }))).toEqual(["b1"]);
    expect(of(...picked, ...recall("t2", { content: "…", broadcast_ids: [] }))).toBeNull();
    const theirs = recall("t2", { content: "…", broadcast_ids: ["b9"] }).map(
      (event) => ({ ...event, persona: "bob" }) as ChatEventDraft,
    );
    expect(of(...picked, ...theirs)).toEqual(["b1"]);
    expect(of(...picked, block("t2", `${RECALL_PREFIX}${RECALL_HINT}`))).toEqual(["b1"]);
    expect(of(...picked, block("t2", `${RECALL_PREFIX}片段`))).toBeNull();
    expect(of(block("t1", `${RECALL_PREFIX}片段`), ...picked)).toEqual(["b1"]);
  });
});
