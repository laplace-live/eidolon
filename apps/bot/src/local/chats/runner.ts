// The local app's chats: one JSONL store in the data home, and per chat one reply at a time: a
// greeting, or the answer to a viewer's line, typed or spoken, which may chain persona to persona.
// A reply runs to its end whether or not anyone still reads it; only stop, delete or shutdown abort
// one. A call takes the chat over while it is on: it opens on her view, and stores its lines.
import { join } from "node:path";
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  ChatStoreError,
  type ChatSummary,
  MAX_PARTICIPANTS,
  type ParticipantId,
  type ReplyMode,
  stampEvents,
  type ViewMessage,
} from "@eidolon/chat";
import { JsonlChatStore } from "@eidolon/chat/jsonl";
import { dataHome, errorText, logger } from "@eidolon/config";
import {
  type ChatOutput,
  type ChatRequest,
  defaultEngineDeps,
  type EngineDeps,
  hearVoiceMessage,
  type LateTools,
  replyModeFor,
  runChat,
  runTurn,
  type TurnOutput,
  type TurnRequest,
  turnView,
} from "@eidolon/engine";
import type { AudioClip } from "@eidolon/providers/speech-batch";
import type { CallBinding, CallEnd, TranscriptLine } from "@eidolon/runtime";
import type { ChatCallInfo, ChatContents } from "../api.ts";
import { localViewer } from "../identity.ts";
import { HearingFailed, hearingRefusal } from "./hearing.ts";
import { LiveTurn } from "./live.ts";

type MessageDraft = Extract<ChatEventDraft, { readonly type: "message" }>;

/** A send, a voice message, a delete or a second call, refused while the chat is in a call. */
export class ChatInCall extends Error {
  override name = "ChatInCall";

  constructor() {
    super("The chat is in a call");
  }
}

/** A call to a persona who isn't in the chat. */
export class NotInChat extends Error {
  override name = "NotInChat";

  constructor() {
    super("That persona isn't in the chat");
  }
}

/** Why a call ended, as its call-ended holds it. */
export type CallEndReason = CallEnd | "shutdown";

/**
 * A call the runner opened in a chat, and the binding of the session that runs it: the session
 * opens on her view of the chat as the call starts, and each finished line it reports, the viewer's
 * or hers, is stored as a `call` message.
 */
export interface ChatCall extends CallBinding {
  readonly id: string;
  readonly seedMessages: readonly ViewMessage[];
  /** The offer was answered on peer connection `pcId`, which a renegotiation names. */
  connected(pcId: string): void;
  /** Stores call-ended, once; a line after it is dropped. Resolves once it is stored or failed. */
  readonly onEnded: (reason: CallEndReason) => Promise<void>;
}

/** The call on in chat `id`, with the connection it was answered on, if it was yet. */
export interface CallInChat extends ChatCallInfo {
  readonly pcId: string | null;
}

/** One persona's turn, saving its files into the turn's chat. */
export type ChatTurn = (
  request: TurnRequest,
  saveAttachment: EngineDeps["saveAttachment"],
) => AsyncIterable<TurnOutput>;

/** A viewer line's answer: the director's decisions and the turns they choose, hop by hop. */
export type ChatAnswer = (
  request: ChatRequest,
  saveAttachment: EngineDeps["saveAttachment"],
) => AsyncIterable<ChatOutput>;

/** A voice message of the viewer's, heard and saved into the chat, as the message to store. */
export type ChatHear = (
  request: Parameters<typeof hearVoiceMessage>[0],
  saveAttachment: EngineDeps["saveAttachment"],
) => Promise<MessageDraft>;

export interface ChatRunnerOptions {
  /** Default: chats/ in the data home. */
  readonly root?: string;
  /** A greeting's turn. Default: the engine's. */
  readonly turn?: ChatTurn;
  /** Default: the engine's. */
  readonly answer?: ChatAnswer;
  /** Default: the engine's. */
  readonly hear?: ChatHear;
}

/** How long shutdown waits for aborted replies to store what they said. */
const STOP_WAIT_MS = 2000;

const engineTurn: ChatTurn = (request, saveAttachment) =>
  runTurn(request, defaultEngineDeps({ saveAttachment }));

const engineAnswer: ChatAnswer = (request, saveAttachment) =>
  runChat(request, defaultEngineDeps({ saveAttachment }));

const engineHear: ChatHear = (request, saveAttachment) =>
  hearVoiceMessage(request, defaultEngineDeps({ saveAttachment }));

interface Chat {
  /** Sends, participant changes and deletes, one at a time. */
  queue: Promise<unknown>;
  /** Appends, one at a time, so each is numbered after the last. */
  appends: Promise<unknown>;
  /** null until read, and after a failed append. */
  lastSeq: number | null;
  live: LiveTurn | null;
  /** Tools interrupted turns left running, by name, until what they bring is stored. */
  readonly late: string[];
  /** Cancels those tools: the chat is deleted, or the server stops. */
  readonly cancel: AbortController;
  /** From the moment it opens, before its call-started is stored, until its end is asked for. */
  call: ActiveCall | null;
}

interface ActiveCall {
  readonly id: string;
  readonly persona: ParticipantId;
  /** Each event the chat stores while the call is on, through its call-ended. */
  readonly live: LiveTurn;
  pcId: string | null;
  /** Set by the first end; it resolves once call-ended is stored or has failed. */
  ending: Promise<void> | null;
}

/**
 * Her view of the chat as her next turn would read it, less her tool calls and their results: what
 * a call bound to it opens on. The call may offer no tools, and Anthropic refuses a request that
 * holds a tool_use block then.
 */
function callSeed(chat: TurnRequest["chat"], persona: ParticipantId): ViewMessage[] {
  return turnView(chat, persona, localViewer().uname ?? "").messages.filter(
    (message) => message.role !== "tool" && !("tool_calls" in message),
  );
}

/** The turn a reply is in, from its `started` to its `ended`. */
interface Running {
  readonly turn: string;
  readonly persona: ParticipantId;
}

export class ChatRunner {
  readonly store: JsonlChatStore;
  readonly #turn: ChatTurn;
  readonly #answer: ChatAnswer;
  readonly #hear: ChatHear;
  readonly #chats = new Map<string, Chat>();

  constructor(options: ChatRunnerOptions = {}) {
    this.store = new JsonlChatStore(options.root ?? join(dataHome(), "chats"), {
      log: (message) => logger.warning(message),
    });
    this.#turn = options.turn ?? engineTurn;
    this.#answer = options.answer ?? engineAnswer;
    this.#hear = options.hear ?? engineHear;
  }

  list(): Promise<ChatSummary[]> {
    return this.store.list();
  }

  async read(id: string, afterSeq?: number): Promise<ChatContents> {
    // Taken first: a tool leaves the list only once what it brought is stored.
    const lateTools = [...(this.#chats.get(id)?.late ?? [])];
    const contents = await this.store.read(id, { afterSeq });
    const refusal = hearingRefusal(await this.participants(id));
    const active = this.callIn(id);
    const call = active === null ? null : { id: active.id, persona: active.persona };
    return { ...contents, lateTools, hearingRefusal: refusal, call };
  }

  /**
   * A new chat of personas the caller validated. One persona's greeting starts at once, and GET
   * live streams it; a group chat doesn't greet. Neither gets a title: the page names a chat by who
   * is in it now until one is given.
   */
  async create(participants: readonly ParticipantId[]): Promise<string> {
    const header: ChatHeader = {
      format: CHAT_FORMAT,
      id: Bun.randomUUIDv7(),
      createdAt: Date.now(),
      participants,
    };
    await this.store.create(header);
    const chat = this.#chat(header.id);
    chat.lastSeq = 0;
    const [persona] = participants;
    if (participants.length === 1 && persona !== undefined) {
      const live = new LiveTurn();
      chat.live = live;
      const { signal } = live.controller;
      void this.#run(header.id, chat, live, persona, async (late, save) => {
        const log = await this.store.read(header.id);
        const viewer = localViewer();
        // With no line to weigh, an auto greeting is text.
        const mode = replyModeFor(log, persona) === "voice" ? "voice" : "text";
        return this.#turn({ chat: log, persona, viewer, kickoff: true, signal, late, mode }, save);
      });
    }
    return header.id;
  }

  /** The personas in chat `id` now. */
  async participants(id: string): Promise<readonly ParticipantId[]> {
    return (await this.store.summary(id)).participants;
  }

  /**
   * Adds personas the caller validated and removes some, as one `participants` event. False, with
   * nothing stored, when one added is already in the chat, one removed isn't, or it would be left
   * with none or more than MAX_PARTICIPANTS. A reply already running finishes as it began.
   */
  changeParticipants(
    id: string,
    add: readonly ParticipantId[],
    remove: readonly ParticipantId[],
  ): Promise<boolean> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
      const now = await this.participants(id);
      const kept = now.filter((p) => !remove.includes(p));
      const size = kept.length + add.length;
      if (
        add.some((p) => now.includes(p)) ||
        kept.length + remove.length !== now.length ||
        size < 1 ||
        size > MAX_PARTICIPANTS
      ) {
        return false;
      }
      await this.#append(id, chat, [
        {
          type: "participants",
          ...(add.length > 0 ? { added: add } : {}),
          ...(remove.length > 0 ? { removed: remove } : {}),
        },
      ]);
      return true;
    });
  }

  /**
   * Stops the running reply, which stores what it said as interrupted and drops the hops queued
   * after it, then stores `text` as the viewer's and starts the answer: the director's decisions
   * and the turns they choose. It streams from the viewer's message on.
   */
  send(id: string, text: string): Promise<LiveTurn> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
      if (chat.call !== null) throw new ChatInCall();
      await this.#interrupt(chat);
      return this.#answerLine(id, chat, {
        type: "message",
        id: Bun.randomUUIDv7(),
        speaker: { kind: "user" },
        text,
      });
    });
  }

  /**
   * As `send`, for a voice message: once the running reply has stopped, `clip` is heard through the
   * hearing role of the chat's first persona, then stored with its transcript, which may be empty.
   * One that can't be heard rejects with HearingFailed, and nothing of it is stored.
   */
  sendVoice(id: string, clip: AudioClip): Promise<LiveTurn> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
      // Before the hearing, which bills.
      if (chat.call !== null) throw new ChatInCall();
      await this.#interrupt(chat);
      const request = { chat: await this.store.read(id), clip, signal: chat.cancel.signal };
      const message = await this.#hear(request, this.#saver(id)).catch((error: unknown) => {
        throw error instanceof ChatStoreError ? error : new HearingFailed(error);
      });
      return this.#answerLine(id, chat, message);
    });
  }

  /** The running reply of chat `id`, else its call's events, or null while it is idle. */
  live(id: string): LiveTurn | null {
    const chat = this.#chats.get(id);
    return chat?.live ?? chat?.call?.live ?? null;
  }

  /** The call on in chat `id`, or null. */
  callIn(id: string): CallInChat | null {
    const call = this.#chats.get(id)?.call ?? null;
    return call && { id: call.id, persona: call.persona, pcId: call.pcId };
  }

  /**
   * Opens a call in chat `id` with `persona`: it stops the running reply, which stores what it said
   * as interrupted, stores call-started, and takes her view of the chat as the call's seed. Until
   * the call ends, the chat refuses sends, voice messages, deletes and other calls with ChatInCall,
   * and GET live streams each event it stores. NotInChat when she isn't in the chat.
   */
  startCall(id: string, persona: ParticipantId): Promise<ChatCall> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
      if (chat.call !== null) throw new ChatInCall();
      if (!(await this.participants(id)).includes(persona)) throw new NotInChat();
      await this.#interrupt(chat);
      const call: ActiveCall = {
        id: Bun.randomUUIDv7(),
        persona,
        live: new LiveTurn(),
        pcId: null,
        ending: null,
      };
      chat.call = call;
      try {
        await this.#append(id, chat, [{ type: "call-started", call: call.id, persona }]);
      } catch (error) {
        chat.call = null;
        call.live.end();
        throw error;
      }
      const onEnded = (reason: CallEndReason) => this.#endCall(id, chat, call, reason);
      let seedMessages: ViewMessage[];
      try {
        seedMessages = callSeed(await this.store.read(id), persona);
      } catch (error) {
        await onEnded("error");
        throw error;
      }
      return {
        id: call.id,
        persona,
        seedMessages,
        onTranscript: (line) => this.#callLine(id, chat, call, line),
        connected: (pcId) => {
          call.pcId = pcId;
        },
        onEnded,
      };
    });
  }

  /** Aborts chat `id`'s running reply, resolving once what it said is stored. */
  async stop(id: string): Promise<void> {
    const chat = this.#chats.get(id);
    // Queued behind a send still storing the viewer's line, so the reply it starts is the one stopped.
    const stopped = chat !== undefined && (await this.#serial(chat, () => this.#interrupt(chat)));
    // Only to answer 404 for a chat that isn't there.
    if (!stopped) await this.store.summary(id);
  }

  async rename(id: string, title: string): Promise<void> {
    await this.#append(id, this.#chat(id), [{ type: "title", title }]);
  }

  /** The chat's chain limit or reply mode, as a `settings` event. */
  async changeSettings(
    id: string,
    change: { readonly chainLimit: number } | { readonly replyMode: ReplyMode },
  ): Promise<void> {
    await this.#append(id, this.#chat(id), [{ type: "settings", ...change }]);
  }

  /** Stops any reply, then removes the chat's folder; ChatInCall during a call. */
  remove(id: string): Promise<void> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
      if (chat.call !== null) throw new ChatInCall();
      await this.#interrupt(chat);
      chat.cancel.abort();
      await chat.appends;
      try {
        await this.store.remove(id);
      } finally {
        if (this.#chats.get(id) === chat) this.#chats.delete(id);
      }
    });
  }

  /**
   * The stop hook: aborts every reply and the tools they left running, ends every call, and waits
   * briefly for each reply to store what it said and each call its call-ended.
   */
  async shutdown(): Promise<void> {
    const running = [...this.#chats.values()].flatMap((chat) => (chat.live ? [chat.live] : []));
    for (const live of running) live.controller.abort();
    for (const chat of this.#chats.values()) chat.cancel.abort();
    // The peers disconnect only after the stop hooks, too late for a call's own end to be stored.
    const calls = [...this.#chats].flatMap(([id, chat]) =>
      chat.call ? [this.#endCall(id, chat, chat.call, "shutdown")] : [],
    );
    if (running.length === 0 && calls.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...running.map((live) => live.ended), ...calls]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    for (const live of running) live.end();
  }

  #chat(id: string): Chat {
    let chat = this.#chats.get(id);
    if (chat === undefined) {
      chat = {
        queue: Promise.resolve(),
        appends: Promise.resolve(),
        lastSeq: null,
        live: null,
        late: [],
        cancel: new AbortController(),
        call: null,
      };
      this.#chats.set(id, chat);
    }
    return chat;
  }

  /** Saves a file into chat `id`'s files/. */
  #saver(id: string): EngineDeps["saveAttachment"] {
    return (bytes, mime) => this.store.saveFile(id, bytes, mime);
  }

  #serial<T>(chat: Chat, task: () => Promise<T>): Promise<T> {
    const result = chat.queue.then(task);
    chat.queue = result.catch(() => {});
    return result;
  }

  /**
   * Numbers `drafts` on from the log's last event and stores them. Asked for during a call, they
   * also go out on its feed once stored.
   */
  #append(id: string, chat: Chat, drafts: readonly ChatEventDraft[]): Promise<ChatEvent[]> {
    // Taken now: the call's end clears it before the appends queued ahead of call-ended are stored.
    const feed = chat.call?.live ?? null;
    const result = chat.appends.then(async () => {
      try {
        const lastSeq = chat.lastSeq ?? (await this.store.summary(id)).lastSeq;
        const events = stampEvents(drafts, lastSeq, Date.now());
        await this.store.append(id, events);
        chat.lastSeq = lastSeq + events.length;
        feed?.push({ type: "events", events });
        return events;
      } catch (error) {
        chat.lastSeq = null;
        throw error;
      }
    });
    chat.appends = result.catch(() => {});
    return result;
  }

  /** Stores a finished line of `call` as a `call` message; one after its end is dropped. */
  #callLine(id: string, chat: Chat, call: ActiveCall, line: TranscriptLine): void {
    if (call.ending !== null) {
      const whose = line.role === "user" ? "the viewer's" : "her";
      logger.warning(`Chat ${id}: ${whose} line came after call ${call.id} ended; dropped`);
      return;
    }
    const speaker =
      line.role === "user"
        ? { kind: "user" as const }
        : { kind: "persona" as const, id: call.persona };
    void this.#append(id, chat, [
      {
        type: "message",
        id: Bun.randomUUIDv7(),
        speaker,
        text: line.text,
        modality: "call",
        ...(line.interrupted ? { interrupted: true } : {}),
      },
    ]).catch((error: unknown) => {
      logger.exception(`Chat ${id}: a line of call ${call.id} wasn't stored`, error);
    });
  }

  /**
   * Stores `call`'s call-ended, after every line asked for before it, then ends its feed. The chat
   * takes sends again at once: they are stored after it.
   */
  #endCall(id: string, chat: Chat, call: ActiveCall, reason: CallEndReason): Promise<void> {
    if (call.ending !== null) return call.ending;
    const stored = this.#append(id, chat, [{ type: "call-ended", call: call.id, reason }]);
    chat.call = null;
    call.ending = stored
      .then(
        () => {},
        (error: unknown) => {
          logger.exception(`Chat ${id}: call ${call.id}'s end wasn't stored`, error);
        },
      )
      .finally(() => call.live.end());
    logger.info(`Chat ${id}: call ${call.id} with ${call.persona} ended (${reason})`);
    return call.ending;
  }

  /**
   * Stores the viewer's `message` and starts the answer to it: the director's decisions and the
   * turns they choose. Its stream starts with the message.
   */
  async #answerLine(id: string, chat: Chat, message: MessageDraft): Promise<LiveTurn> {
    const stored = await this.#append(id, chat, [message]);
    const after = (stored[0] as ChatEvent).seq;
    const live = new LiveTurn();
    chat.live = live;
    live.push({ type: "events", events: stored });
    const { signal } = live.controller;
    void this.#run(id, chat, live, null, async (late, save) => {
      const request: ChatRequest = {
        chat: await this.store.read(id),
        read: () => this.store.read(id),
        viewer: localViewer(),
        after,
        signal,
        late,
      };
      return this.#answer(request, save);
    });
    return live;
  }

  /** Resolves false when no turn was running. */
  async #interrupt(chat: Chat): Promise<boolean> {
    const live = chat.live;
    if (live === null) return false;
    live.controller.abort();
    await live.ended;
    return true;
  }

  /**
   * Runs a reply on the log as stored, storing its events and decisions before `live` carries
   * them, and each before the reply goes on. `greeter` is the persona of a greeting, which fails as
   * hers even before it starts.
   */
  async #run(
    id: string,
    chat: Chat,
    live: LiveTurn,
    greeter: ParticipantId | null,
    start: (
      late: LateTools,
      save: EngineDeps["saveAttachment"],
    ) => Promise<AsyncIterable<ChatOutput>>,
  ): Promise<void> {
    let running: Running | null = null;
    try {
      const outputs = await start(
        { signal: chat.cancel.signal, add: (name, events) => this.#late(id, chat, name, events) },
        this.#saver(id),
      );
      for await (const output of outputs) {
        if (output.type === "events" || output.type === "decision") {
          const drafts = output.type === "events" ? output.events : [output];
          live.push({ type: "events", events: await this.#append(id, chat, drafts) });
          continue;
        }
        if (output.type === "started") running = { turn: output.turn, persona: output.persona };
        live.push(output);
        if (output.type === "ended") running = null;
      }
    } catch (error) {
      const persona = running?.persona ?? greeter;
      await this.#failed(id, chat, live, persona, running?.turn ?? null, error);
    } finally {
      if (running !== null) live.push({ type: "ended", turn: running.turn });
      if (chat.live === live) chat.live = null;
      live.end();
    }
  }

  /**
   * Stores what a tool an interrupted turn left running brings, through the chat's queue so it lands
   * after the viewer's line that interrupted the turn. A deleted chat's is dropped.
   */
  #late(id: string, chat: Chat, name: string, events: Promise<readonly ChatEventDraft[]>): void {
    chat.late.push(name);
    void events
      .then((drafts) =>
        this.#serial(chat, async () => {
          if (drafts.length > 0 && this.#chats.get(id) === chat) {
            await this.#append(id, chat, drafts);
          }
        }),
      )
      .catch((error: unknown) => {
        logger.exception(`Chat ${id}: what ${name} brought after its turn wasn't stored`, error);
      })
      .finally(() => {
        chat.late.splice(chat.late.indexOf(name), 1);
      });
  }

  /**
   * A reply that threw rather than reporting its failure: stored as the turn-failed of the persona
   * whose turn it was, if any and if it can be, else an `error` line.
   */
  async #failed(
    id: string,
    chat: Chat,
    live: LiveTurn,
    persona: ParticipantId | null,
    turn: string | null,
    error: unknown,
  ): Promise<void> {
    const who = persona === null ? "the reply" : `${persona}'s turn`;
    logger.exception(`Chat ${id}: ${who} failed`, error);
    if (persona !== null) {
      try {
        const events = await this.#append(id, chat, [
          {
            type: "turn-failed",
            persona,
            turn: turn ?? Bun.randomUUIDv7(),
            error: errorText(error),
          },
        ]);
        live.push({ type: "events", events });
        return;
      } catch (storing) {
        logger.exception(`Chat ${id}: the failed turn wasn't stored`, storing);
      }
    }
    live.push({
      type: "error",
      code: "internal",
      message: "Eidolon hit an error; the terminal has the details",
    });
  }
}
