// A turn in a chat with other personas: the others named in her instruction, the viewer labelled,
// stop sequences and the cut at a line she writes as someone else, and what Mem0 may store.
import "../../config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserContext } from "@eidolon/access";
import {
  CHAT_FORMAT,
  type ChatEventDraft,
  type ChatHeader,
  type ParticipantId,
  stampEvents,
} from "@eidolon/chat";
import { consoleSink, dataHome, type LogRecord, logger, resetSettings } from "@eidolon/config";
import type { ContextProvider, FrameMetadata, LlmTool } from "@eidolon/core";
import { MEM0_STORE_KEY } from "@eidolon/memory";
import { SpeakerCut } from "../src/group.ts";
import { runTurn } from "../src/turn.ts";
import type {
  EngineDeps,
  Mind,
  MindChunk,
  MindRequest,
  PersonaParts,
  TurnOutput,
  TurnRequest,
} from "../src/types.ts";

const PERSONAS: Record<string, string> = {
  ann: "identity:\n  name: 安妮\n  shortName: 安安\n",
  bea: "identity:\n  name: 露比\n  shortName: 小露\n  summary: a singer\n",
  ken: "identity:\n  name: Ken\n",
};
const ID = "0190f5c8-0000-7000-8000-0000000000aa";
const GROUP: ChatHeader = {
  format: CHAT_FORMAT,
  id: ID,
  createdAt: 0,
  participants: ["ann", "bea", "ken"],
};
const SINGLE: ChatHeader = { ...GROUP, participants: ["ann"] };
const VIEWER: UserContext = { mid: 0, uname: "小明", face: null, isLoggedIn: true };
const DONE: MindChunk = { type: "done", finishReason: "stop" };

beforeAll(() => {
  for (const [id, yaml] of Object.entries(PERSONAS)) {
    const dir = join(dataHome(), "personas", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "persona.yaml"), yaml);
  }
});
afterAll(() => {
  for (const id of Object.keys(PERSONAS)) {
    rmSync(join(dataHome(), "personas", id), { recursive: true, force: true });
  }
  resetSettings();
});

const logs: LogRecord[] = [];
beforeEach(() => {
  logger.setSink((record) => logs.push(record));
});
afterEach(() => {
  logs.length = 0;
  logger.setSink(consoleSink);
});

const user = (text: string): ChatEventDraft => ({
  type: "message",
  id: `u-${text}`,
  speaker: { kind: "user" },
  text,
});
const from = (persona: ParticipantId, text: string): ChatEventDraft => ({
  type: "message",
  id: `${persona}-${text}`,
  speaker: { kind: "persona", id: persona },
  text,
});

function request(header: ChatHeader, ...drafts: ChatEventDraft[]): TurnRequest {
  return {
    chat: { header, events: stampEvents(drafts, 0, 1000) },
    persona: "ann",
    viewer: VIEWER,
    signal: new AbortController().signal,
  };
}

const text = (t: string): MindChunk => ({ type: "text", text: t });

/** A mind that answers each call with the next of `rounds`, and records when a stream is let go. */
function fakeMind(...rounds: (readonly MindChunk[])[]) {
  const requests: MindRequest[] = [];
  let closed = 0;
  const mind: Mind = {
    async *stream(request) {
      requests.push(request);
      try {
        yield* rounds[requests.length - 1] ?? [DONE];
      } finally {
        closed++;
      }
    },
  };
  return { mind, requests, closed: () => closed };
}

interface Seen {
  others?: readonly string[];
  metadata?: FrameMetadata;
}

function deps(mind: Mind, seen: Seen = {}, tools: LlmTool[] = []): EngineDeps {
  let n = 0;
  const watcher: ContextProvider = {
    onContext: async ({ metadata }) => {
      seen.metadata = { ...metadata };
    },
    errorMessage: () => "",
  };
  const parts: PersonaParts = {
    systemInstruction: "SYSTEM",
    providers: [{ label: "Mem0", provider: watcher }],
    gate: null,
    tools,
    memories: async () => [],
  };
  return {
    createMind: () => mind,
    parts: async (_persona, _viewer, _chat, options) => {
      seen.others = options?.others;
      return parts;
    },
    saveAttachment: async () => {
      throw new Error("no files here");
    },
    fetchImage: async () => {
      throw new Error("no images here");
    },
    newId: () => `id-${++n}`,
  };
}

async function collect(outputs: AsyncIterable<TurnOutput>): Promise<TurnOutput[]> {
  const all: TurnOutput[] = [];
  for await (const output of outputs) all.push(output);
  return all;
}

const deltas = (outputs: readonly TurnOutput[]) =>
  outputs.flatMap((output) => (output.type === "delta" ? [output.text] : []));
const said = (outputs: readonly TurnOutput[]) =>
  outputs.flatMap((output) =>
    output.type === "events"
      ? output.events.flatMap((event) => (event.type === "message" ? [event.text] : []))
      : [],
  );

describe("a turn in a group chat", () => {
  test("names the others without their summaries, labels the viewer, and stops at the two others heard from last", async () => {
    const { mind, requests } = fakeMind([text("我也好"), DONE]);
    const seen: Seen = {};
    await collect(
      runTurn(
        request(GROUP, user("大家好"), from("bea", "你好呀"), from("ken", "Hi"), user("安妮呢")),
        deps(mind, seen),
      ),
    );
    expect(seen.others).toEqual(["露比", "Ken"]);
    expect(requests[0]?.messages).toEqual([
      { role: "user", content: "小明：大家好" },
      { role: "user", content: "露比：你好呀\nKen：Hi" },
      { role: "user", content: "小明：安妮呢" },
    ]);
    expect(requests[0]?.stop).toEqual(["\nKen：", "\nKen:", "\n露比：", "\n露比:"]);
  });

  test("stops at others who haven't spoken yet, in the chat's order", async () => {
    const { mind, requests } = fakeMind([DONE]);
    await collect(runTurn(request(GROUP, user("在吗")), deps(mind)));
    expect(requests[0]?.stop).toEqual(["\n露比：", "\n露比:", "\nKen：", "\nKen:"]);
  });

  test("hands Mem0 the viewer's lines and hers, unlabelled, and none of the others'", async () => {
    const { mind } = fakeMind([DONE]);
    const seen: Seen = {};
    await collect(
      runTurn(
        request(
          GROUP,
          user("我养了猫"),
          from("bea", "我最喜欢狗"),
          from("ann", "猫好"),
          user("嗯"),
        ),
        deps(mind, seen),
      ),
    );
    expect(seen.metadata?.[MEM0_STORE_KEY]).toEqual([
      { role: "user", content: "我养了猫" },
      { role: "assistant", content: "猫好" },
      { role: "user", content: "嗯" },
    ]);
  });

  test("cuts her reply at a line she writes as another, the rest of the stream unread", async () => {
    const ran: string[] = [];
    const selfie: LlmTool = {
      schema: { name: "take_selfie", description: "", properties: {}, required: [] },
      cancelOnInterruption: true,
      timeoutSecs: null,
      run: async () => {
        ran.push("take_selfie");
        return {};
      },
    };
    const { mind, requests, closed } = fakeMind([
      text("好呀"),
      text("\n\n小"),
      text("露: 我也"),
      text("要"),
      { type: "tool-calls", calls: [{ id: "c1", name: "take_selfie", arguments: {} }] },
      DONE,
    ]);
    const outputs = await collect(
      runTurn(request(GROUP, user("出去玩吗")), deps(mind, {}, [selfie])),
    );
    expect(deltas(outputs)).toEqual(["好呀"]);
    expect(said(outputs)).toEqual(["好呀"]);
    expect(ran).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(closed()).toBe(1);
    expect(logs.map((record) => record.message)).toContain(
      "[chat] ann's reply was cut where she wrote as someone else",
    );
  });

  test("cuts her reply at a line she writes as the viewer, whose label stops nothing", async () => {
    const named = fakeMind([text("好呀\n小明：我也去"), DONE]);
    const outputs = await collect(runTurn(request(GROUP, user("出去玩吗")), deps(named.mind)));
    expect(said(outputs)).toEqual(["好呀"]);
    expect(named.requests[0]?.stop).toEqual(["\n露比：", "\n露比:", "\nKen：", "\nKen:"]);

    const nameless = fakeMind([text("好呀\n观众: 我也去"), DONE]);
    const anonymous = { ...request(GROUP, user("出去玩吗")), viewer: { ...VIEWER, uname: null } };
    expect(said(await collect(runTurn(anonymous, deps(nameless.mind))))).toEqual(["好呀"]);
  });

  test("shows a held line once it can't be a name, and what is held when the round ends", async () => {
    const { mind } = fakeMind([text("嗯\n露"), text("台很好\nK"), DONE]);
    const outputs = await collect(runTurn(request(GROUP, user("去哪")), deps(mind)));
    expect(deltas(outputs)).toEqual(["嗯", "\n露台很好", "\nK"]);
    expect(said(outputs)).toEqual(["嗯\n露台很好\nK"]);
  });

  test("marks a reply her provider stopped short, held line and all, but not one cut at another's", async () => {
    const messages = (outputs: readonly TurnOutput[]) =>
      outputs.flatMap((output) =>
        output.type === "events"
          ? output.events.flatMap((event) =>
              event.type === "message" ? [[event.text, event.cutOff]] : [],
            )
          : [],
      );
    const length: MindChunk = { type: "done", finishReason: "length" };
    const stopped = fakeMind([text("嗯\n露"), length]);
    const short = await collect(runTurn(request(GROUP, user("讲个故事")), deps(stopped.mind)));
    expect(messages(short)).toEqual([["嗯\n露", "length"]]);
    const written = fakeMind([text("好呀\n小露: 我也"), length]);
    const cut = await collect(runTurn(request(GROUP, user("出去玩吗")), deps(written.mind)));
    expect(messages(cut)).toEqual([["好呀", undefined]]);
  });

  test("in a chat of one, sends no stop, names no one and leaves Mem0 the context", async () => {
    const { mind, requests } = fakeMind([text("嗨\n露比：你好"), DONE]);
    const seen: Seen = {};
    const outputs = await collect(
      runTurn(request(SINGLE, user("你好"), from("ann", "在呢"), user("嗯")), deps(mind, seen)),
    );
    expect("stop" in (requests[0] ?? {})).toBe(false);
    expect(seen.others).toEqual([]);
    expect(seen.metadata).toEqual({});
    expect(requests[0]?.messages).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "在呢" },
      { role: "user", content: "嗯" },
    ]);
    expect(said(outputs)).toEqual(["嗨\n露比：你好"]);
  });

  test("one who left is no longer named, but her lines still stop, cut and stay out of Mem0", async () => {
    const { mind, requests } = fakeMind([text("嗨\n露比：你好"), DONE]);
    const seen: Seen = {};
    const left: ChatEventDraft = { type: "participants", removed: ["bea"] };
    const pair: ChatHeader = { ...GROUP, participants: ["ann", "bea"] };
    const outputs = await collect(
      runTurn(
        request(pair, user("你好"), from("bea", "我走啦"), left, user("嗯")),
        deps(mind, seen),
      ),
    );
    expect(seen.others).toEqual([]);
    expect(requests[0]?.stop).toEqual(["\n露比：", "\n露比:"]);
    expect(seen.metadata?.[MEM0_STORE_KEY]).toEqual([
      { role: "user", content: "你好" },
      { role: "user", content: "嗯" },
    ]);
    expect(said(outputs)).toEqual(["嗨"]);
  });
});

describe("SpeakerCut", () => {
  const cut = () => new SpeakerCut(["露比", "小露", "Ken", "Ken", ""]);

  test("cuts at a name or short name and either colon, case-blind, the first line included", () => {
    for (const line of ["露比：嗨", "小露:嗨", "ken：hi", "KEN: hi"]) {
      const speaker = cut();
      expect(speaker.push(line)).toBe("");
      expect(speaker.cut).toBe(true);
    }
  });

  test("drops the line breaks before the cut, and everything after it", () => {
    const speaker = cut();
    expect(speaker.push("嗯\n\n\nKen")).toBe("嗯");
    expect(speaker.push(": hi\n我")).toBe("");
    expect(speaker.push("还在")).toBe("");
    expect(speaker.flush()).toBe("");
  });

  test("a name that runs on, or comes later in the line, is hers", () => {
    const speaker = cut();
    expect(speaker.push("Kenny: hi\n我和露比：")).toBe("Kenny: hi\n我和露比：");
    expect(speaker.push("\n露比")).toBe("");
    expect(speaker.push("们\n")).toBe("\n露比们");
    expect(speaker.cut).toBe(false);
  });

  test("a flush keeps a line it hasn't started open", () => {
    const speaker = cut();
    expect(speaker.push("好\n")).toBe("好");
    expect(speaker.flush()).toBe("\n");
    expect(speaker.push("露比：")).toBe("");
    expect(speaker.cut).toBe(true);

    const started = cut();
    expect(started.push("好\n露")).toBe("好");
    expect(started.flush()).toBe("\n露");
    expect(started.push("比：")).toBe("比：");
  });
});
