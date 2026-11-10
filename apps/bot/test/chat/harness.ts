// Fakes for the chat endpoint's tests: an engine whose minds, recall, director and speech are
// scripted and record what they were given, and the boot deps of a production server.

import { existsSync, readdirSync } from "node:fs";
import type { UserContext } from "@eidolon/access";
import * as access from "@eidolon/access";
import type { ChatEvent, ChatStreamLine } from "@eidolon/chat";
import { activePersona, dataHome } from "@eidolon/config";
import type { DirectorDecision, DirectorInput } from "@eidolon/context";
import type { ChatDeps, EngineDeps, MindChunk, MindRequest, PersonaParts } from "@eidolon/engine";
import { usageRecord } from "@eidolon/providers";
import type { AudioClip } from "@eidolon/providers/speech-batch";
import type { BotDeps } from "../../src/server.ts";
import { ANSWER, allowedOffer } from "../fakes.ts";

export const CHAT_ID = "0190f5c8-0000-7000-8000-0000000000cc";
export const MILKY = "milky-green";

type ContextProvider = PersonaParts["providers"][number]["provider"];

export interface MindCall {
  readonly persona: string;
  readonly messages: readonly unknown[];
  readonly signal: AbortSignal;
  /** The usage scope a report from inside the mind lands in. */
  readonly scope: { readonly source: string | null; readonly session: string | null };
}

export interface EngineRecord {
  readonly minds: MindCall[];
  /** The viewer each turn's parts were built for. */
  readonly viewers: UserContext[];
  /** The key each turn's parts were asked under. */
  readonly chatKeys: (string | undefined)[];
  readonly spoken: string[];
  readonly heard: AudioClip[];
  readonly decisions: DirectorInput[];
}

export interface FakeEngineOptions {
  /** Whether her voice role can speak a voice message. Default false. */
  readonly canSpeak?: boolean;
  /** Who answers each decision; default: the first participant, then no one. */
  readonly choose?: (input: DirectorInput, call: number) => readonly string[];
  /** Her stream; default: one line of text. */
  readonly mind?: (request: MindRequest, call: number) => AsyncIterable<MindChunk>;
  readonly transcribe?: (clip: AudioClip) => Promise<{ text: string; durationMs: number | null }>;
  /** Her voice; default: `mp3:` and the text. */
  readonly synthesize?: (text: string) => Promise<void>;
  /** Her tools; default: none. */
  readonly tools?: PersonaParts["tools"];
}

/** An engine of fakes, saving files through the endpoint's own `saveAttachment`. */
export function fakeEngine(options: FakeEngineOptions = {}): {
  engine: (saveAttachment: EngineDeps["saveAttachment"]) => ChatDeps;
  record: EngineRecord;
} {
  const record: EngineRecord = {
    minds: [],
    viewers: [],
    chatKeys: [],
    spoken: [],
    heard: [],
    decisions: [],
  };
  // What the stream archive does each turn: a block of recall at the top of her view.
  const recall: ContextProvider = {
    onContext: async ({ context }) => {
      context.setMessages([{ role: "system", content: "回忆" }, ...context.getMessages()]);
    },
    errorMessage: () => "",
  };
  let ids = 0;
  const tools = options.tools ?? [];
  const engine = (saveAttachment: EngineDeps["saveAttachment"]): ChatDeps => ({
    createMind: () => ({
      stream(request: MindRequest): AsyncIterable<MindChunk> {
        const persona = activePersona().id;
        const report = usageRecord({ role: "mind", provider: "openrouter", model: "m", units: {} });
        record.minds.push({
          persona,
          messages: request.messages,
          signal: request.signal,
          scope: { source: report.source, session: report.session },
        });
        const call = record.minds.length;
        if (options.mind) return options.mind(request, call);
        return (async function* (): AsyncGenerator<MindChunk> {
          yield { type: "text", text: `${persona}说${call}` };
          yield { type: "done", finishReason: "stop" };
        })();
      },
    }),
    parts: async (_persona, viewer, _chat, options) => {
      record.viewers.push(viewer);
      record.chatKeys.push(options?.chatKey);
      return {
        systemInstruction: "SYSTEM",
        providers: [{ label: "Recall", provider: recall }],
        gate: null,
        tools,
        memories: async () => [],
      };
    },
    saveAttachment,
    fetchImage: async () => {
      throw new Error("no images here");
    },
    newId: () => `id-${++ids}`,
    speech: {
      canSpeak: () => options.canSpeak ?? false,
      synthesize: async (text) => {
        record.spoken.push(text);
        await options.synthesize?.(text);
        return {
          bytes: new TextEncoder().encode(`mp3:${text}`),
          mime: "audio/mpeg",
          durationMs: 900,
        };
      },
      transcribe: async (clip) => {
        record.heard.push(clip);
        return options.transcribe ? options.transcribe(clip) : { text: "听到了", durationMs: 1500 };
      },
    },
    director: {
      decide: async (input): Promise<DirectorDecision> => {
        record.decisions.push(input);
        const chosen = options.choose
          ? options.choose(input, record.decisions.length)
          : input.hop === 0
            ? [input.participants[0]?.id as string]
            : [];
        return {
          replies: chosen.map((persona) => ({
            persona,
            mode:
              input.participants.find((p) => p.id === persona)?.replyMode === "voice"
                ? "voice"
                : "text",
          })),
          source: input.participants.length > 1 ? "model" : "single",
          scores: {},
        };
      },
    },
  });
  return { engine, record };
}

/** Every file under the data home, as paths relative to it. */
export function homeFiles(): string[] {
  const home = dataHome();
  return existsSync(home) ? (readdirSync(home, { recursive: true }) as string[]).toSorted() : [];
}

/** Every NDJSON line of a response. */
export async function linesOf(response: Response): Promise<ChatStreamLine[]> {
  const text = await response.text();
  return text === ""
    ? []
    : text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
}

/** The events of every `events` line, in order. */
export function eventsIn(lines: readonly ChatStreamLine[]): ChatEvent[] {
  return lines.flatMap((line) => (line.type === "events" ? line.events : []));
}

/** startBotServer's modules as production passes them, with the real access module. */
export function productionDeps(): BotDeps {
  return {
    access: {
      ...access,
      admitOffer: async (input) => allowedOffer(input),
      anonOfferQuota: () => ({ maxPerWindow: 5, windowSeconds: 3600 }),
    },
    imagegen: { selfieResponse: () => new Response(null, { status: 404 }) },
    memory: { memoryAdmin: () => null },
    retrieval: {
      warmTokenizer: () => {},
      resolveDbPath: () => "/fake/index",
      warmStreamCatalog: async () => {},
    },
    runtime: {
      configureLogging: () => {},
      warmAudioModels: async () => {},
      createSignallingServer: () => ({
        offer: async () => ({ status: 200, body: ANSWER }),
        patch: async () => ({ status: 200, body: { status: "success" } }),
        close: async () => {},
        activeSessions: 0,
      }),
    },
    turn: {
      iceServiceFromEnv: () => ({
        browserPayload: async () => ({ iceServers: [] }),
        serverPlan: async () => ({ iceServers: [], relayOnly: false, turnUrl: null }),
      }),
    },
    mcp: { createMcpHandler: async () => ({ handle: async () => new Response("mcp") }) },
  };
}
