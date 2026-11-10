// Voice messages over fake minds and fake speech clients: her reply spoken and stored with its
// audio, the voice-style tool, synthesis that fails or is interrupted, the viewer's clip heard as a
// line, how each persona's reply mode is settled, and a chat whose director chooses voice.
import "../../config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserContext } from "@eidolon/access";
import {
  type Attachment,
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  type ParticipantId,
  stampEvents,
} from "@eidolon/chat";
import {
  activePersona,
  consoleSink,
  dataHome,
  type LogRecord,
  logger,
  resetSettings,
} from "@eidolon/config";
import { Director } from "@eidolon/context";
import type { LlmTool } from "@eidolon/core";
import { usageRecord } from "@eidolon/providers";
import { type ChatDeps, type ChatOutput, runChat } from "../src/chat.ts";
import { runTurn } from "../src/turn.ts";
import type {
  EngineDeps,
  Mind,
  MindChunk,
  MindRequest,
  PartsOptions,
  PersonaParts,
  SpeechDeps,
  TurnOutput,
  TurnRequest,
} from "../src/types.ts";
import { hearVoiceMessage, replyModeFor, UNHEARD, voiceHearer } from "../src/voice.ts";

const PERSONAS: Record<string, string> = {
  vera: "identity:\n  name: 维拉\n",
  wren: "identity:\n  name: 小雀\nchat:\n  replyMode: voice\n",
  yuki: "identity:\n  name: 雪\nchat:\n  replyMode: Text\n",
};
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
const messagesAt = (level: string) =>
  logs.filter((record) => record.level === level).map((record) => record.message);
beforeEach(() => {
  logger.setSink((record) => logs.push(record));
});
afterEach(() => {
  logs.length = 0;
  logger.setSink(consoleSink);
});

function header(...participants: ParticipantId[]): ChatHeader {
  return {
    format: CHAT_FORMAT,
    id: "0190f5c8-0000-7000-8000-0000000000dd",
    createdAt: 0,
    participants,
  };
}

const user = (text: string, extra: Partial<ChatEventDraft> = {}): ChatEventDraft =>
  ({
    type: "message",
    id: `u-${text}`,
    speaker: { kind: "user" },
    text,
    ...extra,
  }) as ChatEventDraft;

function chat(head: ChatHeader, ...drafts: ChatEventDraft[]): TurnRequest["chat"] {
  return { header: head, events: stampEvents(drafts, 0, 1000) };
}

const PARTS: PersonaParts = {
  systemInstruction: "SYSTEM",
  providers: [],
  gate: null,
  tools: [],
  memories: async () => [],
};

/** A mind that answers its nth call with `rounds[n]`, and with nothing after them. */
function fakeMind(...rounds: (readonly MindChunk[])[]): { mind: Mind; requests: MindRequest[] } {
  const requests: MindRequest[] = [];
  return {
    requests,
    mind: {
      async *stream(request) {
        requests.push(request);
        yield* rounds[requests.length - 1] ?? [DONE];
      },
    },
  };
}

/** The usage scope a request was billed in: its source and session. */
type Billed = readonly [string | null, string | null];

interface Spoken {
  readonly text: string;
  readonly voice: string | undefined;
  readonly persona: string;
  readonly billed: Billed;
}

/** Speaks `mp3:<text>`, 1234.4 ms long, and hears `heard`; `speak` stands in for synthesis. */
function fakeSpeech(
  options: {
    canSpeak?: boolean | (() => boolean);
    speak?: (signal: AbortSignal) => Promise<void>;
    heard?: string;
  } = {},
) {
  const spoken: Spoken[] = [];
  const heard: { mime: string; persona: string; billed: Billed }[] = [];
  const billed = (): Billed => {
    const record = usageRecord({ role: "voice", provider: "fish", model: "m", units: {} });
    return [record.source, record.session];
  };
  const speech: SpeechDeps = {
    canSpeak: () => {
      const { canSpeak = true } = options;
      return typeof canSpeak === "function" ? canSpeak() : canSpeak;
    },
    synthesize: async (text, { voice, signal }) => {
      spoken.push({ text, voice, persona: activePersona().id, billed: billed() });
      await options.speak?.(signal);
      return {
        bytes: new TextEncoder().encode(`mp3:${text}`),
        mime: "audio/mpeg",
        durationMs: 1234.4,
      };
    },
    transcribe: async (clip) => {
      heard.push({ mime: clip.mime, persona: activePersona().id, billed: billed() });
      return { text: options.heard ?? "你好呀", durationMs: 2500 };
    },
  };
  return { speech, spoken, heard };
}

/** Saves a file as `<its text>.<mp3|png>`, audio or image by its type. */
const saveAttachment: EngineDeps["saveAttachment"] = async (bytes, mime) => {
  const name = new TextDecoder().decode(bytes);
  return mime.startsWith("audio/")
    ? { kind: "audio", name: `${name}.mp3`, mime: "audio/mpeg" }
    : { kind: "image", name: `${name}.png`, mime };
};

function deps(mind: Mind, speech: SpeechDeps, overrides: Partial<EngineDeps> = {}): EngineDeps {
  let n = 0;
  return {
    createMind: () => mind,
    parts: async () => PARTS,
    saveAttachment,
    fetchImage: async () => ({ bytes: new TextEncoder().encode("photo"), mime: "image/png" }),
    newId: () => `id-${++n}`,
    speech,
    ...overrides,
  };
}

async function collect(
  outputs: AsyncIterable<TurnOutput>,
  onOutput: (output: TurnOutput) => void = () => {},
): Promise<TurnOutput[]> {
  const all: TurnOutput[] = [];
  for await (const output of outputs) {
    all.push(output);
    onOutput(output);
  }
  return all;
}

const eventsOf = (outputs: readonly TurnOutput[]): ChatEventDraft[] =>
  outputs.flatMap((output) => (output.type === "events" ? [...output.events] : []));

function voiceTurn(log: TurnRequest["chat"], overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    chat: log,
    persona: "vera",
    viewer: VIEWER,
    signal: new AbortController().signal,
    mode: "voice",
    ...overrides,
  };
}

const AUDIO: Attachment = {
  kind: "audio",
  name: "mp3:[轻笑]好呀，我在呢.mp3",
  mime: "audio/mpeg",
  durationMs: 1234,
};

describe("a voice message from her", () => {
  test("streams her words, then speaks them as her and stores the audio with the transcript", async () => {
    const { mind } = fakeMind([
      { type: "text", text: "[轻笑]好呀，" },
      { type: "text", text: "我在呢" },
      DONE,
    ]);
    const { speech, spoken } = fakeSpeech();
    const log = chat(header("vera"), user("在吗"));
    const outputs = await collect(runTurn(voiceTurn(log), deps(mind, speech)));
    expect(outputs).toEqual([
      { type: "started", turn: "id-1", persona: "vera" },
      { type: "delta", turn: "id-1", text: "[轻笑]好呀，" },
      { type: "delta", turn: "id-1", text: "我在呢" },
      { type: "tool", turn: "id-1", name: "voice", state: "running" },
      { type: "tool", turn: "id-1", name: "voice", state: "done" },
      {
        type: "events",
        events: [
          {
            type: "message",
            id: "id-2",
            speaker: { kind: "persona", id: "vera" },
            text: "[轻笑]好呀，我在呢",
            modality: "voice",
            attachments: [AUDIO],
          },
        ],
      },
      { type: "ended", turn: "id-1" },
    ]);
    // Her cues go to the client, which strips them for a voice that can't read them.
    expect(spoken).toEqual([
      {
        text: "[轻笑]好呀，我在呢",
        voice: undefined,
        persona: "vera",
        billed: ["chat", log.header.id],
      },
    ]);
  });

  test("asks for her parts' voice variant only for a voice message", async () => {
    const asked: (PartsOptions | undefined)[] = [];
    const parts: EngineDeps["parts"] = async (_persona, _viewer, _chat, options) => {
      asked.push(options);
      return PARTS;
    };
    const { speech } = fakeSpeech();
    const log = chat(header("vera"), user("在吗"));
    await collect(runTurn(voiceTurn(log), deps(fakeMind().mind, speech, { parts })));
    await collect(
      runTurn(voiceTurn(log, { mode: "text" }), deps(fakeMind().mind, speech, { parts })),
    );
    await collect(
      runTurn({ ...voiceTurn(log), mode: undefined }, deps(fakeMind().mind, speech, { parts })),
    );
    expect(asked).toEqual([
      { others: [], voice: true },
      { others: [], voice: false },
      { others: [], voice: false },
    ]);
  });

  test("speaks in the voice her voice-style tool switched to, for this message alone", async () => {
    const style: LlmTool = {
      schema: { name: "change_voice_style", description: "", properties: {}, required: [] },
      cancelOnInterruption: true,
      timeoutSecs: null,
      run: async (_call, effects) => {
        await effects.switchVoice("v-gentle");
        return { ok: true, style: "gentle" };
      },
    };
    const { mind } = fakeMind(
      [{ type: "tool-calls", calls: [{ id: "c1", name: "change_voice_style", arguments: {} }] }],
      [{ type: "text", text: "这样可以嘛" }, DONE],
    );
    const { speech, spoken } = fakeSpeech();
    const engine = deps(mind, speech, { parts: async () => ({ ...PARTS, tools: [style] }) });
    const log = chat(header("vera"), user("温柔一点"));
    const outputs = await collect(runTurn(voiceTurn(log), engine));
    expect(spoken.map(({ text, voice }) => ({ text, voice }))).toEqual([
      { text: "这样可以嘛", voice: "v-gentle" },
    ]);
    expect(eventsOf(outputs).find((event) => event.type === "tool-result")).toMatchObject({
      result: { ok: true, style: "gentle" },
    });

    // A text reply has no voice to switch.
    const text = await collect(
      runTurn(
        voiceTurn(log, { mode: "text" }),
        deps(
          fakeMind([
            {
              type: "tool-calls",
              calls: [{ id: "c1", name: "change_voice_style", arguments: {} }],
            },
          ]).mind,
          speech,
          {
            parts: async () => ({ ...PARTS, tools: [style] }),
          },
        ),
      ),
    );
    expect(eventsOf(text).find((event) => event.type === "tool-result")).toMatchObject({
      result: { error: "The function `change_voice_style` failed and returned no result." },
    });
  });

  test("keeps her photos after the audio", async () => {
    const selfie: LlmTool = {
      schema: { name: "take_selfie", description: "", properties: {}, required: [] },
      cancelOnInterruption: true,
      timeoutSecs: null,
      run: async (_call, effects) => {
        await effects.sendServerMessage({ type: "selfie", urls: ["/api/selfie/a.png"] });
        return { ok: true };
      },
    };
    const { mind } = fakeMind(
      [{ type: "tool-calls", calls: [{ id: "c1", name: "take_selfie", arguments: {} }] }],
      [{ type: "text", text: "拍好啦" }, DONE],
    );
    const { speech } = fakeSpeech();
    const engine = deps(mind, speech, { parts: async () => ({ ...PARTS, tools: [selfie] }) });
    const outputs = await collect(runTurn(voiceTurn(chat(header("vera"), user("自拍"))), engine));
    expect(eventsOf(outputs).at(-1)).toMatchObject({
      type: "message",
      text: "拍好啦",
      modality: "voice",
      attachments: [
        { kind: "audio", name: "mp3:拍好啦.mp3", mime: "audio/mpeg", durationMs: 1234 },
        { kind: "image", name: "photo.png", mime: "image/png" },
      ],
    });
  });

  test("a reply with no words is stored as it would be in text, unspoken", async () => {
    const { speech, spoken } = fakeSpeech();
    for (const rounds of [[DONE], [{ type: "text", text: "  \n" }, DONE]] as MindChunk[][]) {
      const outputs = await collect(
        runTurn(voiceTurn(chat(header("vera"), user("嗯"))), deps(fakeMind(rounds).mind, speech)),
      );
      expect(outputs.some((output) => output.type === "tool")).toBe(false);
      expect(eventsOf(outputs).every((event) => event.type !== "message" || !event.modality)).toBe(
        true,
      );
    }
    const refused = await collect(
      runTurn(
        voiceTurn(chat(header("vera"), user("嗯"))),
        deps(fakeMind([{ type: "done", finishReason: "refusal" }]).mind, speech),
      ),
    );
    expect(eventsOf(refused)).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: "vera" },
        text: "",
        cutOff: "refusal",
      },
    ]);
    expect(spoken).toEqual([]);
  });

  test("goes as text when her voice can't speak it, the failure recorded after it", async () => {
    const { mind } = fakeMind([{ type: "text", text: "晚安" }, DONE]);
    const { speech } = fakeSpeech({
      speak: async () => {
        throw new Error("Fish Audio: 402 Payment Required");
      },
    });
    const outputs = await collect(
      runTurn(voiceTurn(chat(header("vera"), user("睡了"))), deps(mind, speech)),
    );
    expect(outputs.filter((output) => output.type === "tool")).toEqual([
      { type: "tool", turn: "id-1", name: "voice", state: "running" },
      { type: "tool", turn: "id-1", name: "voice", state: "failed" },
    ]);
    expect(eventsOf(outputs)).toEqual([
      { type: "message", id: "id-2", speaker: { kind: "persona", id: "vera" }, text: "晚安" },
      {
        type: "turn-failed",
        persona: "vera",
        turn: "id-1",
        error: "Fish Audio: 402 Payment Required",
        code: "voice-failed",
      },
    ]);
    expect(messagesAt("WARNING")).toEqual([
      "[chat] vera's voice message goes as text: Fish Audio: 402 Payment Required",
    ]);
  });

  test("goes as text when its audio can't be saved", async () => {
    const { speech } = fakeSpeech();
    const outputs = await collect(
      runTurn(
        voiceTurn(chat(header("vera"), user("在吗"))),
        deps(fakeMind([{ type: "text", text: "在" }, DONE]).mind, speech, {
          saveAttachment: async () => {
            throw new Error("ENOSPC");
          },
        }),
      ),
    );
    expect(eventsOf(outputs).map((event) => event.type)).toEqual(["message", "turn-failed"]);
    expect(eventsOf(outputs)[1]).toMatchObject({ code: "voice-failed", error: "ENOSPC" });
  });

  test("an interruption while she is spoken keeps her words as interrupted text", async () => {
    const controller = new AbortController();
    const { speech, spoken } = fakeSpeech({
      speak: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    const outputs = await collect(
      runTurn(
        voiceTurn(chat(header("vera"), user("讲个故事")), { signal: controller.signal }),
        deps(fakeMind([{ type: "text", text: "从前有座山" }, DONE]).mind, speech),
      ),
      (output) => {
        if (output.type === "tool" && output.state === "running") controller.abort();
      },
    );
    expect(spoken).toHaveLength(1);
    expect(outputs.filter((output) => output.type === "tool")).toHaveLength(1);
    expect(eventsOf(outputs)).toEqual([
      {
        type: "message",
        id: "id-2",
        speaker: { kind: "persona", id: "vera" },
        text: "从前有座山",
        interrupted: true,
      },
    ]);
  });
});

describe("a voice message from the viewer", () => {
  const clip = { bytes: new TextEncoder().encode("clip"), mime: "audio/webm;codecs=opus" };

  test("is heard by the chat's first persona, billed to the chat, and stored with its clip", async () => {
    const { speech, heard } = fakeSpeech();
    const log = chat(header("wren", "vera"), { type: "participants", removed: ["wren"] });
    expect(voiceHearer(log)).toBe("vera");
    const message = await hearVoiceMessage(
      { chat: log, clip, signal: new AbortController().signal },
      { saveAttachment, newId: () => "m1", speech },
    );
    expect(heard).toEqual([
      { mime: "audio/webm;codecs=opus", persona: "vera", billed: ["chat", log.header.id] },
    ]);
    expect(message).toEqual({
      type: "message",
      id: "m1",
      speaker: { kind: "user" },
      text: "你好呀",
      modality: "voice",
      attachments: [{ kind: "audio", name: "clip.mp3", mime: "audio/mpeg", durationMs: 2500 }],
    });
  });

  test("heard as nothing, is stored empty, and her view and the director read （听不清）", async () => {
    const { speech } = fakeSpeech({ heard: "" });
    const head = header("vera", "wren");
    const message = await hearVoiceMessage(
      { chat: chat(head), clip, signal: new AbortController().signal },
      { saveAttachment, newId: () => "m1", speech },
    );
    expect(message.text).toBe("");
    expect(UNHEARD).toBe("（听不清）");

    const { mind, requests } = fakeMind([{ type: "text", text: "嗯？" }, DONE]);
    const log = chat(head, message);
    const asked: Parameters<Director["decide"]>[0][] = [];
    const decide = async (input: Parameters<Director["decide"]>[0]) => {
      asked.push(input);
      const persona = asked.length === 1 ? ["vera"] : [];
      return {
        replies: persona.map((id) => ({ persona: id, mode: "text" as const })),
        source: "model" as const,
        scores: {},
      };
    };
    const engine: ChatDeps = {
      ...deps(mind, fakeSpeech({ canSpeak: false }).speech),
      director: { decide },
    };
    const events: ChatEvent[] = [...log.events];
    for await (const output of runChat(
      {
        chat: log,
        read: async () => ({ header: head, events: [...events] }),
        viewer: VIEWER,
        after: 1,
        signal: new AbortController().signal,
      },
      engine,
    )) {
      const stored =
        output.type === "events" ? output.events : output.type === "decision" ? [output] : [];
      events.push(...stampEvents(stored, events.length, 2000));
    }
    expect(asked[0]?.lines).toEqual([
      { speaker: { kind: "user" }, text: UNHEARD, modality: "voice" },
    ]);
    expect(requests[0]?.messages).toEqual([{ role: "user", content: `小明：${UNHEARD}` }]);
    expect(events.findLast((event) => event.type === "message")).toMatchObject({ text: "嗯？" });
    // The log keeps what was heard: nothing.
    expect(events[0]).toMatchObject({ type: "message", text: "", modality: "voice" });
  });

  test("a failure to hear it stores nothing", async () => {
    const saved: string[] = [];
    const speech: SpeechDeps = {
      ...fakeSpeech().speech,
      transcribe: async () => {
        throw new Error("OpenAI: 401 Unauthorized");
      },
    };
    await expect(
      hearVoiceMessage(
        { chat: chat(header("vera")), clip, signal: new AbortController().signal },
        {
          saveAttachment: async (bytes, mime) => {
            saved.push(mime);
            return saveAttachment(bytes, mime);
          },
          newId: () => "m1",
          speech,
        },
      ),
    ).rejects.toThrow("OpenAI: 401 Unauthorized");
    expect(saved).toEqual([]);
  });
});

describe("how she answers: replyModeFor", () => {
  test("the chat's mode, else hers, else auto; voice and auto are text while she can't speak", () => {
    const log = chat(header("vera", "wren", "yuki"));
    const can = fakeSpeech().speech;
    const cannot = fakeSpeech({ canSpeak: false }).speech;
    expect(["vera", "wren", "yuki"].map((id) => replyModeFor(log, id, can))).toEqual([
      "auto",
      "voice",
      "text",
    ]);
    expect(["vera", "wren", "yuki"].map((id) => replyModeFor(log, id, cannot))).toEqual([
      "text",
      "text",
      "text",
    ]);
    expect(messagesAt("INFO")).toEqual([
      "[chat] wren answers in text: her voice role can't speak a voice message",
    ]);
    const set = chat(
      header("vera", "wren", "yuki"),
      { type: "settings", replyMode: "text" },
      { type: "settings", chainLimit: 2 },
      { type: "settings", replyMode: "voice" },
    );
    expect(["vera", "wren", "yuki"].map((id) => replyModeFor(set, id, can))).toEqual([
      "voice",
      "voice",
      "voice",
    ]);
  });

  test("asks whether she can speak as her", () => {
    const asked: string[] = [];
    const { speech } = fakeSpeech({
      canSpeak: () => {
        asked.push(activePersona().id);
        return true;
      },
    });
    replyModeFor(chat(header("vera")), "vera", speech);
    replyModeFor(chat(header("yuki")), "yuki", speech);
    expect(asked).toEqual(["vera"]);
  });
});

describe("a chat that answers in voice", () => {
  /** A chat as the runner keeps it: each output's events stored before the next is taken. */
  async function answer(head: ChatHeader, drafts: ChatEventDraft[], engine: ChatDeps) {
    const events: ChatEvent[] = stampEvents(drafts, 0, 1000);
    const outputs: ChatOutput[] = [];
    for await (const output of runChat(
      {
        chat: { header: head, events: [...events] },
        read: async () => ({ header: head, events: [...events] }),
        viewer: VIEWER,
        after: events.length,
        signal: new AbortController().signal,
      },
      engine,
    )) {
      outputs.push(output);
      const stored =
        output.type === "events" ? output.events : output.type === "decision" ? [output] : [];
      events.push(...stampEvents(stored, events.length, 2000));
    }
    return { events, outputs };
  }

  type Body = { state: Record<string, unknown>; questions: Record<string, unknown> };

  function jev(noul: number, bodies: Body[]) {
    return new Director({
      apiKey: "k",
      fetch: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Body;
        bodies.push(body);
        return Response.json({
          answers: Object.fromEntries(
            Object.keys(body.questions).map((key) => [key, { type: "noul", noul }]),
          ),
        });
      }) as unknown as typeof fetch,
    });
  }

  test("a chat of one in auto asks only voice_moment, and her reply follows it", async () => {
    const bodies: Body[] = [];
    const { speech, spoken } = fakeSpeech();
    const engine: ChatDeps = {
      ...deps(fakeMind([{ type: "text", text: "我也想你" }, DONE]).mind, speech),
      director: jev(0.9, bodies),
    };
    const { events } = await answer(header("vera"), [user("想你了")], engine);
    expect(bodies.map((body) => Object.keys(body.questions))).toEqual([["voice_moment"]]);
    expect(events.filter((event) => event.type === "decision")).toMatchObject([
      {
        replies: [{ persona: "vera", mode: "voice" }],
        source: "single",
        scores: { voice_moment: 0.9 },
      },
    ]);
    expect(spoken.map(({ text }) => text)).toEqual(["我也想你"]);
    expect(events.at(-1)).toMatchObject({ type: "message", text: "我也想你", modality: "voice" });
  });

  test("a chat of one asks nothing when her mode is settled, and a chat's text wins", async () => {
    const bodies: Body[] = [];
    const run = async (persona: string, ...settings: ChatEventDraft[]) => {
      const { speech, spoken } = fakeSpeech();
      const engine: ChatDeps = {
        ...deps(fakeMind([{ type: "text", text: "好" }, DONE]).mind, speech),
        director: jev(0.9, bodies),
      };
      const { events } = await answer(header(persona), [...settings, user("嗨")], engine);
      const decision = events.find((event) => event.type === "decision");
      return {
        replies: decision?.type === "decision" ? decision.replies : null,
        spoken: spoken.length,
      };
    };
    expect(await run("wren")).toEqual({ replies: [{ persona: "wren", mode: "voice" }], spoken: 1 });
    expect(await run("yuki")).toEqual({ replies: [{ persona: "yuki", mode: "text" }], spoken: 0 });
    expect(await run("wren", { type: "settings", replyMode: "text" })).toEqual({
      replies: [{ persona: "wren", mode: "text" }],
      spoken: 0,
    });
    expect(bodies).toEqual([]);
  });

  test("a group asks voice_moment once when someone is auto, and each answers in her own mode", async () => {
    const bodies: Body[] = [];
    const { speech, spoken } = fakeSpeech();
    const decide = jev(0.9, bodies);
    const engine: ChatDeps = {
      ...deps(
        {
          async *stream() {
            yield { type: "text", text: `${activePersona().identity.name}在` };
            yield DONE;
          },
        },
        speech,
      ),
      director: decide,
    };
    const head = header("vera", "yuki", "wren");
    const { events } = await answer(
      head,
      [{ type: "settings", chainLimit: 0 }, user("@维拉 @雪 在吗", {})],
      engine,
    );
    expect(Object.keys(bodies[0]?.questions ?? {}).filter((key) => key === "voice_moment")).toEqual(
      ["voice_moment"],
    );
    expect(events.find((event) => event.type === "decision")).toMatchObject({
      replies: [
        { persona: "vera", mode: "voice" },
        { persona: "yuki", mode: "text" },
      ],
      source: "mention",
    });
    expect(spoken.map(({ text, persona }) => `${persona}: ${text}`)).toEqual(["vera: 维拉在"]);
    expect(
      events.flatMap((event) =>
        event.type === "message" && event.speaker.kind === "persona"
          ? [`${event.speaker.id} ${event.modality ?? "text"}`]
          : [],
      ),
    ).toEqual(["vera voice", "yuki text"]);
  });
});
