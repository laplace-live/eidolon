// The local app's chats: one JSONL store in the data home, and per chat one reply at a time: a
// greeting, or a viewer line's answer, which may chain persona to persona. A reply runs to its end
// whether or not anyone still reads it; only stop, delete or shutdown abort one.
import { join } from "node:path";
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  type ChatSummary,
  MAX_PARTICIPANTS,
  type ParticipantId,
  stampEvents,
} from "@eidolon/chat";
import { JsonlChatStore } from "@eidolon/chat/jsonl";
import { dataHome, errorText, logger } from "@eidolon/config";
import {
  type ChatOutput,
  type ChatRequest,
  defaultEngineDeps,
  type EngineDeps,
  type LateTools,
  runChat,
  runTurn,
  type TurnOutput,
  type TurnRequest,
} from "@eidolon/engine";
import type { ChatContents } from "../api.ts";
import { localViewer } from "../identity.ts";
import { LiveTurn } from "./live.ts";

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

export interface ChatRunnerOptions {
  /** Default: chats/ in the data home. */
  readonly root?: string;
  /** A greeting's turn. Default: the engine's. */
  readonly turn?: ChatTurn;
  /** Default: the engine's. */
  readonly answer?: ChatAnswer;
}

/** How long shutdown waits for aborted replies to store what they said. */
const STOP_WAIT_MS = 2000;

const engineTurn: ChatTurn = (request, saveAttachment) =>
  runTurn(request, defaultEngineDeps({ saveAttachment }));

const engineAnswer: ChatAnswer = (request, saveAttachment) =>
  runChat(request, defaultEngineDeps({ saveAttachment }));

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
  readonly #chats = new Map<string, Chat>();

  constructor(options: ChatRunnerOptions = {}) {
    this.store = new JsonlChatStore(options.root ?? join(dataHome(), "chats"), {
      log: (message) => logger.warning(message),
    });
    this.#turn = options.turn ?? engineTurn;
    this.#answer = options.answer ?? engineAnswer;
  }

  list(): Promise<ChatSummary[]> {
    return this.store.list();
  }

  async read(id: string, afterSeq?: number): Promise<ChatContents> {
    // Taken first: a tool leaves the list only once what it brought is stored.
    const lateTools = [...(this.#chats.get(id)?.late ?? [])];
    return { ...(await this.store.read(id, { afterSeq })), lateTools };
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
        return this.#turn({ chat: log, persona, viewer, kickoff: true, signal, late }, save);
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
      await this.#interrupt(chat);
      const message = await this.#append(id, chat, [
        { type: "message", id: Bun.randomUUIDv7(), speaker: { kind: "user" }, text },
      ]);
      const after = (message[0] as ChatEvent).seq;
      const live = new LiveTurn();
      chat.live = live;
      live.push({ type: "events", events: message });
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
    });
  }

  /** The running reply of chat `id`, or null while it is idle. */
  live(id: string): LiveTurn | null {
    return this.#chats.get(id)?.live ?? null;
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

  /** From the next viewer line on; a reply already running keeps the limit it began with. */
  async setChainLimit(id: string, chainLimit: number): Promise<void> {
    await this.#append(id, this.#chat(id), [{ type: "settings", chainLimit }]);
  }

  /** Stops any reply, then removes the chat's folder. */
  remove(id: string): Promise<void> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
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
   * The stop hook: aborts every reply and the tools they left running, and waits briefly for each
   * reply to store what it said.
   */
  async shutdown(): Promise<void> {
    const running = [...this.#chats.values()].flatMap((chat) => (chat.live ? [chat.live] : []));
    for (const live of running) live.controller.abort();
    for (const chat of this.#chats.values()) chat.cancel.abort();
    if (running.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(running.map((live) => live.ended)),
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
      };
      this.#chats.set(id, chat);
    }
    return chat;
  }

  #serial<T>(chat: Chat, task: () => Promise<T>): Promise<T> {
    const result = chat.queue.then(task);
    chat.queue = result.catch(() => {});
    return result;
  }

  /** Numbers `drafts` on from the log's last event and stores them. */
  #append(id: string, chat: Chat, drafts: readonly ChatEventDraft[]): Promise<ChatEvent[]> {
    const result = chat.appends.then(async () => {
      try {
        const lastSeq = chat.lastSeq ?? (await this.store.summary(id)).lastSeq;
        const events = stampEvents(drafts, lastSeq, Date.now());
        await this.store.append(id, events);
        chat.lastSeq = lastSeq + events.length;
        return events;
      } catch (error) {
        chat.lastSeq = null;
        throw error;
      }
    });
    chat.appends = result.catch(() => {});
    return result;
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
        (bytes, mime) => this.store.saveFile(id, bytes, mime),
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
