// The local app's chats: one JSONL store in the data home, and per chat one reply at a time: a
// greeting, or the answer to a viewer's line, typed or spoken, which may chain persona to persona.
// A reply runs to its end whether or not anyone still reads it; only stop, delete, a call, shutdown
// and a newer viewer line stop one. A call takes the chat over while it is on: it opens on her view,
// and stores its lines.
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
  summarize,
  type ViewMessage,
} from "@eidolon/chat";
import { JsonlChatStore } from "@eidolon/chat/jsonl";
import { dataHome, errorText, logger } from "@eidolon/config";
import type { DirectorReply } from "@eidolon/context";
import {
  type ChatOutput,
  type ChatRequest,
  callLine,
  callPhotos,
  callSeed,
  defaultEngineDeps,
  type EngineDeps,
  hearVoiceMessage,
  type LateTools,
  type OwedLine,
  replyModeFor,
  runChat,
  runTurn,
  type TurnOutput,
  type TurnRequest,
} from "@eidolon/engine";
import type { AudioClip } from "@eidolon/providers/speech-batch";
import type { CallBinding, CallEnd, GroupCallBinding, TranscriptLine } from "@eidolon/runtime";
import type { ChatCallInfo, ChatContents } from "../api.ts";
import { localViewer } from "../identity.ts";
import { type GroupCallRefusal, groupCallRefusal } from "./group.ts";
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
 * or hers, is stored as a `call` message, as is each photo she sends.
 */
export interface ChatCall extends CallBinding {
  readonly id: string;
  readonly seedMessages: readonly ViewMessage[];
  /** The offer was answered on peer connection `pcId`, which a renegotiation names. */
  connected(pcId: string): void;
  /** Stores call-ended, once; a line after it is dropped. Resolves once it is stored or failed. */
  readonly onEnded: (reason: CallEndReason) => Promise<void>;
}

/**
 * A call the runner opened with every persona in a chat, and the binding of the session that runs
 * it: the session opens on the chat as stored, and each line and decision it reports is stored, the
 * lines as `call` messages, each decision against the line it answers as the chat numbered it.
 */
export interface GroupChatCall extends GroupCallBinding {
  readonly id: string;
  connected(pcId: string): void;
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
  reply: Reply | null;
  /** What a reply stopped by a newer line left unanswered, until the next stored line's answer. */
  owed: readonly OwedLine[];
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
  /** Every persona in the chat is on it, `persona` hosting. */
  readonly group: boolean;
  /** Each event the chat stores while the call is on, through its call-ended. */
  readonly live: LiveTurn;
  pcId: string | null;
  /** Set by the first end; it resolves once call-ended is stored or has failed. */
  ending: Promise<void> | null;
  /** A group call's lines, by their seq on the call, to the seq the chat stores each at. */
  readonly seqs: Map<number, Promise<number>>;
}

/** The turn a reply is in, from its `started` to its `ended`. */
interface Running {
  readonly turn: string;
  readonly persona: ParticipantId;
}

/** A running reply, and what it has done of the viewer lines it answers. */
class Reply {
  readonly live = new LiveTurn();
  /** Oldest first: the lines it was given as owed, then its own; none for a greeting. */
  readonly lines: readonly OwedLine[];
  /** Who each decision chose, by the line it was about. */
  readonly decided = new Map<number, readonly DirectorReply[]>();
  /** Each persona who completed a turn: it reached its end with the reply not aborted. */
  readonly done = new Set<ParticipantId>();
  /** The chat had one persona as it began, so her turn answers every line. */
  single = false;
  /** The running turn has written. */
  writing = false;
  /**
   * "yield": a newer line waits for the running turn to end, and stops the reply there. "abort": a
   * stop, a delete, a call or shutdown aborted it, so it owes nothing.
   */
  stopping: "yield" | "abort" | null = null;

  constructor(lines: readonly OwedLine[]) {
    this.lines = lines;
  }

  /** Aborts it at once, owing nothing. */
  abort(): void {
    this.stopping = "abort";
    this.live.controller.abort();
  }

  /**
   * The lines it leaves unanswered, oldest first: each no decision was made for, and each whose
   * chosen personas didn't all complete a turn, with those who didn't.
   */
  owed(): OwedLine[] {
    if (this.single && this.done.size > 0) return [];
    return this.lines.flatMap(({ line, replies }) => {
      const chosen = replies ?? this.decided.get(line);
      if (chosen === undefined) return [{ line }];
      const left = chosen.filter(({ persona }) => !this.done.has(persona));
      return left.length > 0 ? [{ line, replies: left }] : [];
    });
  }
}

export class ChatRunner {
  readonly store: JsonlChatStore;
  readonly #turn: ChatTurn;
  readonly #answer: ChatAnswer;
  readonly #hear: ChatHear;
  readonly #chats = new Map<string, Chat>();
  /** Each call whose end was asked for, until its call-ended, after its last lines, is stored. */
  readonly #endings = new Set<Promise<void>>();

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
    const participants = await this.participants(id);
    const refusal = hearingRefusal(participants);
    const active = this.callIn(id);
    const call =
      active === null
        ? null
        : {
            id: active.id,
            persona: active.persona,
            ...(active.group ? { group: true as const } : {}),
          };
    const groupCall = groupCallRefusal(participants) === null;
    return { ...contents, lateTools, hearingRefusal: refusal, call, groupCall };
  }

  /** Why the personas of chat `id` can't be called together now; null when they can. */
  async groupCallRefusal(id: string): Promise<GroupCallRefusal | null> {
    return groupCallRefusal(await this.participants(id));
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
      const reply = new Reply([]);
      chat.reply = reply;
      const { signal } = reply.live.controller;
      void this.#run(header.id, chat, reply, persona, async (late, save) => {
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
   * Stops the running reply, letting a persona who has written finish her turn, then stores `text`
   * as the viewer's and starts the answer, the replies the stopped reply still owed first: the
   * director's decisions and the turns they choose. It streams from the viewer's message on.
   */
  send(id: string, text: string): Promise<LiveTurn> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
      if (chat.call !== null) throw new ChatInCall();
      await this.#yield(chat);
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
   * One that can't be heard rejects with HearingFailed, and nothing of it is stored; the next line
   * takes up what the stopped reply owed.
   */
  sendVoice(id: string, clip: AudioClip): Promise<LiveTurn> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
      // Before the hearing, which bills.
      if (chat.call !== null) throw new ChatInCall();
      await this.#yield(chat);
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
    return chat?.reply?.live ?? chat?.call?.live ?? null;
  }

  /** The call on in chat `id`, or null. */
  callIn(id: string): CallInChat | null {
    const call = this.#chats.get(id)?.call ?? null;
    return (
      call && {
        id: call.id,
        persona: call.persona,
        ...(call.group ? { group: true as const } : {}),
        pcId: call.pcId,
      }
    );
  }

  /**
   * Opens a call in chat `id` with `persona`: it stops the running reply, which stores what it said
   * as interrupted, stores call-started, and takes her view of the chat as the call's seed. Until
   * the call ends, the chat refuses sends, voice messages, deletes and other calls with ChatInCall,
   * and GET live streams each event it stores. NotInChat when she isn't in the chat.
   */
  startCall(id: string, persona: ParticipantId): Promise<ChatCall> {
    return this.#openCall(id, persona, false, async (chat, call) => {
      const seedMessages: ViewMessage[] = callSeed(
        await this.store.read(id),
        persona,
        localViewer().uname ?? "",
      );
      return {
        persona,
        seedMessages,
        onTranscript: (line: TranscriptLine) => this.#callLine(id, chat, call, line),
      };
    });
  }

  /**
   * As `startCall`, with every persona in the chat on the call, `host` hearing the viewer: the call
   * opens on the chat as stored, its call-started marked `group`, and each line and decision it
   * reports is stored. The caller checks first that they can be called together.
   */
  startGroupCall(id: string, host: ParticipantId): Promise<GroupChatCall> {
    return this.#openCall(id, host, true, async (chat, call) => ({
      group: true as const,
      persona: host,
      chat: await this.store.read(id),
      onEvents: (events: readonly ChatEvent[]) => this.#groupEvents(id, chat, call, events),
    }));
  }

  /**
   * Stops the running reply, stores call-started, and binds the call with `bind`, adding what
   * every call's binding has; a call it can't bind ends at once, as an error.
   */
  #openCall<T>(
    id: string,
    persona: ParticipantId,
    group: boolean,
    bind: (chat: Chat, call: ActiveCall) => Promise<T>,
  ): Promise<T & Pick<ChatCall, "id" | "onServerMessage" | "connected" | "onEnded">> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
      if (chat.call !== null) throw new ChatInCall();
      if (!(await this.participants(id)).includes(persona)) throw new NotInChat();
      await this.#interrupt(chat);
      // After the awaits: a delete that came during them has aborted the chat's tools and hearing,
      // and removes the chat next.
      if (chat.cancel.signal.aborted) throw new ChatStoreError("not-found", `No chat ${id}`);
      const call: ActiveCall = {
        id: Bun.randomUUIDv7(),
        persona,
        group,
        live: new LiveTurn(),
        pcId: null,
        ending: null,
        seqs: new Map(),
      };
      chat.call = call;
      try {
        await this.#append(id, chat, [
          { type: "call-started", call: call.id, persona, ...(group ? { group: true } : {}) },
        ]);
      } catch (error) {
        chat.call = null;
        call.live.end();
        throw error;
      }
      const onEnded = (reason: CallEndReason) => this.#endCall(id, chat, call, reason);
      try {
        return {
          ...(await bind(chat, call)),
          id: call.id,
          onServerMessage: (data: Readonly<Record<string, unknown>>) =>
            this.#callPhotos(id, chat, call, data),
          connected: (pcId: string) => {
            call.pcId = pcId;
          },
          onEnded,
        };
      } catch (error) {
        await onEnded("error");
        throw error;
      }
    });
  }

  /** Aborts chat `id`'s running reply, owing nothing, resolving once what it said is stored. */
  async stop(id: string): Promise<void> {
    const chat = this.#chats.get(id);
    // Before the queue, where a send may be waiting for her to finish writing.
    chat?.reply?.abort();
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

  /**
   * Stops any reply and the voice message being heard, then removes the chat's folder; ChatInCall
   * during a call.
   */
  remove(id: string): Promise<void> {
    const chat = this.#chat(id);
    // Before the aborts: a refused delete leaves the chat's tools and hearing as they were.
    if (chat.call !== null) return Promise.reject(new ChatInCall());
    // Before the queue, which a voice message being heard holds until its time limit; the reply
    // first, as shutdown does, so the tools it leaves running are cancelled as late ones.
    chat.reply?.abort();
    chat.cancel.abort();
    return this.#serial(chat, async () => {
      await this.#interrupt(chat);
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
   * briefly for each reply to store what it said and each call, a call just hung up too, its
   * call-ended.
   */
  async shutdown(): Promise<void> {
    const running = [...this.#chats.values()].flatMap((chat) => (chat.reply ? [chat.reply] : []));
    for (const reply of running) reply.abort();
    for (const chat of this.#chats.values()) chat.cancel.abort();
    // The peers disconnect only after the stop hooks, too late for a call's own end to be stored.
    for (const [id, chat] of this.#chats) {
      if (chat.call) void this.#endCall(id, chat, chat.call, "shutdown");
    }
    const endings = [...this.#endings];
    if (running.length === 0 && endings.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...running.map((reply) => reply.live.ended), ...endings]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    for (const reply of running) reply.live.end();
  }

  #chat(id: string): Chat {
    let chat = this.#chats.get(id);
    if (chat === undefined) {
      chat = {
        queue: Promise.resolve(),
        appends: Promise.resolve(),
        lastSeq: null,
        reply: null,
        owed: [],
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
   * Numbers `drafts` on from the log's last event and stores them, in the order asked for, even
   * when they are still being made. Asked for during a call, they also go out on its feed once
   * stored.
   */
  #append(
    id: string,
    chat: Chat,
    drafts: readonly ChatEventDraft[] | Promise<readonly ChatEventDraft[]>,
  ): Promise<ChatEvent[]> {
    // Taken now: the call's end clears it before the appends queued ahead of call-ended are stored.
    const feed = chat.call?.live ?? null;
    const result = chat.appends.then(async () => {
      try {
        const made = await drafts;
        if (made.length === 0) return [];
        const lastSeq = chat.lastSeq ?? (await this.store.summary(id)).lastSeq;
        const events = stampEvents(made, lastSeq, Date.now());
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

  /** Whether `call` still takes what its session reports; `what` came too late if not. */
  #takes(id: string, call: ActiveCall, what: string): boolean {
    if (call.ending === null) return true;
    logger.warning(`Chat ${id}: ${what} came after call ${call.id} ended; dropped`);
    return false;
  }

  /** Stores a finished line of `call` as a `call` message; one after its end is dropped. */
  #callLine(id: string, chat: Chat, call: ActiveCall, line: TranscriptLine): void {
    if (!this.#takes(id, call, `${line.role === "user" ? "the viewer's" : "her"} line`)) return;
    void this.#append(id, chat, [callLine(line, call.persona)]).catch((error: unknown) => {
      logger.exception(`Chat ${id}: a line of call ${call.id} wasn't stored`, error);
    });
  }

  /**
   * Stores a group call's lines as `call` messages and its decisions, each against the seq its line
   * was stored at, in the order reported; one after the call's end is dropped.
   */
  #groupEvents(id: string, chat: Chat, call: ActiveCall, events: readonly ChatEvent[]): void {
    if (!this.#takes(id, call, "a line")) return;
    const failed = (error: unknown) => {
      logger.exception(`Chat ${id}: a line of call ${call.id} wasn't stored`, error);
    };
    for (const event of events) {
      if (event.type === "message") {
        const stored = this.#append(id, chat, [
          {
            type: "message",
            id: Bun.randomUUIDv7(),
            speaker: event.speaker,
            text: event.text,
            modality: "call",
            ...(event.interrupted ? { interrupted: true } : {}),
            ...(event.cutOff === undefined ? {} : { cutOff: event.cutOff }),
          },
        ]);
        stored.catch(failed);
        const seq = stored.then(([line]) => (line as ChatEvent).seq);
        // A decision awaits it, if one answers it.
        seq.catch(() => {});
        call.seqs.set(event.seq, seq);
      } else if (event.type === "decision") {
        const after = call.seqs.get(event.after);
        if (after === undefined) {
          logger.warning(`Chat ${id}: a decision of call ${call.id} answers no line of it`);
          continue;
        }
        const { seq: _, at: __, ...decision } = event;
        void this.#append(
          id,
          chat,
          after.then((line) => [{ ...decision, after: line }]),
        ).catch(failed);
      }
    }
  }

  /**
   * Stores the photos a selfie message of `call` names as her `call` message, copied from the
   * selfie store into the chat; a group call's names whose photo it is. It takes its place among the
   * call's lines as it arrives.
   */
  #callPhotos(
    id: string,
    chat: Chat,
    call: ActiveCall,
    data: Readonly<Record<string, unknown>>,
  ): void {
    if (data.type !== "selfie" || !this.#takes(id, call, "her photo")) return;
    const persona = call.group && typeof data.persona === "string" ? data.persona : call.persona;
    // Shutdown waits for it as for her lines.
    const photos = callPhotos(data, persona, this.#saver(id)).then((draft) =>
      draft === null ? [] : [draft],
    );
    void this.#append(id, chat, photos).catch((error: unknown) => {
      logger.exception(`Chat ${id}: a photo of call ${call.id} wasn't stored`, error);
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
    const ending = stored
      .then(
        () => {},
        (error: unknown) => {
          logger.exception(`Chat ${id}: call ${call.id}'s end wasn't stored`, error);
        },
      )
      .finally(() => {
        call.live.end();
        this.#endings.delete(ending);
      });
    call.ending = ending;
    this.#endings.add(ending);
    const who = call.group ? `everyone, ${call.persona} hosting,` : call.persona;
    logger.info(`Chat ${id}: call ${call.id} with ${who} ended (${reason})`);
    return call.ending;
  }

  /**
   * Stores the viewer's `message` and starts the answer to it and to the lines the chat owes: the
   * director's decisions and the turns they choose. Its stream starts with the message.
   */
  async #answerLine(id: string, chat: Chat, message: MessageDraft): Promise<LiveTurn> {
    const stored = await this.#append(id, chat, [message]);
    const after = (stored[0] as ChatEvent).seq;
    const owed = chat.owed;
    chat.owed = [];
    const reply = new Reply([...owed, { line: after }]);
    chat.reply = reply;
    const { live } = reply;
    live.push({ type: "events", events: stored });
    const { signal } = live.controller;
    void this.#run(id, chat, reply, null, async (late, save) => {
      const log = await this.store.read(id);
      reply.single = summarize(log.header, log.events).participants.length === 1;
      const request: ChatRequest = {
        chat: log,
        read: () => this.store.read(id),
        viewer: localViewer(),
        after,
        ...(owed.length > 0 ? { owed } : {}),
        signal,
        late,
      };
      return this.#answer(request, save);
    });
    return live;
  }

  /** Aborts the running reply and drops what the chat owed. Resolves false when none was running. */
  async #interrupt(chat: Chat): Promise<boolean> {
    chat.owed = [];
    const reply = chat.reply;
    if (reply === null) return false;
    reply.abort();
    await reply.live.ended;
    return true;
  }

  /**
   * Stops the running reply for a newer viewer line: once its running turn ends if she has written,
   * else at once. Resolves once what it said is stored, the chat owing what it left unanswered.
   */
  async #yield(chat: Chat): Promise<void> {
    const reply = chat.reply;
    if (reply === null) return;
    reply.stopping ??= "yield";
    if (!reply.writing) reply.live.controller.abort();
    await reply.live.ended;
    if (reply.stopping === "yield") chat.owed = reply.owed();
  }

  /**
   * Runs a reply on the log as stored, storing its events and decisions before `live` carries
   * them, and each before the reply goes on. `greeter` is the persona of a greeting, which fails as
   * hers even before it starts.
   */
  async #run(
    id: string,
    chat: Chat,
    reply: Reply,
    greeter: ParticipantId | null,
    start: (
      late: LateTools,
      save: EngineDeps["saveAttachment"],
    ) => Promise<AsyncIterable<ChatOutput>>,
  ): Promise<void> {
    const { live } = reply;
    const { signal } = live.controller;
    let running: Running | null = null;
    const ended = ({ persona }: Running) => {
      running = null;
      reply.writing = false;
      if (!signal.aborted) reply.done.add(persona);
      // A newer line let her finish: the reply goes no further.
      if (reply.stopping === "yield") live.controller.abort();
    };
    try {
      const outputs = await start(
        { signal: chat.cancel.signal, add: (name, events) => this.#late(id, chat, name, events) },
        this.#saver(id),
      );
      for await (const output of outputs) {
        if (output.type === "events" || output.type === "decision") {
          const drafts = output.type === "events" ? output.events : [output];
          live.push({ type: "events", events: await this.#append(id, chat, drafts) });
          if (output.type === "decision") reply.decided.set(output.after, output.replies);
          continue;
        }
        if (output.type === "started") running = { turn: output.turn, persona: output.persona };
        if (output.type === "delta" && output.text !== "") reply.writing = true;
        live.push(output);
        if (output.type === "ended" && running !== null) ended(running);
      }
    } catch (error) {
      const persona = running?.persona ?? greeter;
      await this.#failed(id, chat, live, persona, running?.turn ?? null, error);
    } finally {
      if (running !== null) {
        live.push({ type: "ended", turn: running.turn });
        ended(running);
      }
      if (chat.reply === reply) chat.reply = null;
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
