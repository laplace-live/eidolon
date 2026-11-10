// The local app's chats: one JSONL store in the data home, and per chat one turn at a time. A turn
// runs to its end whether or not anyone still reads it; only stop, delete or shutdown abort one.
import { join } from "node:path";
import {
  CHAT_FORMAT,
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  ChatStoreError,
  type ChatSummary,
  type ParticipantId,
  stampEvents,
} from "@eidolon/chat";
import { JsonlChatStore } from "@eidolon/chat/jsonl";
import { dataHome, errorText, logger } from "@eidolon/config";
import {
  defaultEngineDeps,
  type EngineDeps,
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

export interface ChatRunnerOptions {
  /** Default: chats/ in the data home. */
  readonly root?: string;
  /** Default: the engine's. */
  readonly turn?: ChatTurn;
}

/** How long shutdown waits for aborted turns to store what they said. */
const STOP_WAIT_MS = 2000;

const engineTurn: ChatTurn = (request, saveAttachment) =>
  runTurn(request, defaultEngineDeps({ saveAttachment }));

interface Chat {
  /** Sends and deletes, one at a time. */
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

export class ChatRunner {
  readonly store: JsonlChatStore;
  readonly #turn: ChatTurn;
  readonly #chats = new Map<string, Chat>();

  constructor(options: ChatRunnerOptions = {}) {
    this.store = new JsonlChatStore(options.root ?? join(dataHome(), "chats"), {
      log: (message) => logger.warning(message),
    });
    this.#turn = options.turn ?? engineTurn;
  }

  list(): Promise<ChatSummary[]> {
    return this.store.list();
  }

  async read(id: string, afterSeq?: number): Promise<ChatContents> {
    // Taken first: a tool leaves the list only once what it brought is stored.
    const lateTools = [...(this.#chats.get(id)?.late ?? [])];
    return { ...(await this.store.read(id, { afterSeq })), lateTools };
  }

  /** A new chat; with one persona, her greeting starts at once and GET live streams it. */
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
      chat.live = new LiveTurn();
      void this.#reply(header.id, chat, chat.live, persona, true);
    }
    return header.id;
  }

  /** Who answers the viewer in chat `id`: its one persona. */
  async replier(id: string): Promise<ParticipantId> {
    const [persona] = (await this.store.summary(id)).participants;
    if (persona === undefined) throw new ChatStoreError("invalid", `Chat ${id} has no persona`);
    return persona;
  }

  /**
   * Stops the running turn, which stores what it said as interrupted, then stores `text` as the
   * viewer's and starts `persona`'s reply. The answer streams from the viewer's message on.
   */
  send(id: string, text: string, persona: ParticipantId): Promise<LiveTurn> {
    const chat = this.#chat(id);
    return this.#serial(chat, async () => {
      await this.#interrupt(chat);
      const message = await this.#append(id, chat, [
        { type: "message", id: Bun.randomUUIDv7(), speaker: { kind: "user" }, text },
      ]);
      const decision = await this.#append(id, chat, [
        {
          type: "decision",
          after: (message[0] as ChatEvent).seq,
          replies: [{ persona, mode: "text" }],
          source: "single",
        },
      ]);
      const live = new LiveTurn();
      chat.live = live;
      live.push({ type: "events", events: message });
      live.push({ type: "events", events: decision });
      void this.#reply(id, chat, live, persona, false);
      return live;
    });
  }

  /** The running turn of chat `id`, or null while it is idle. */
  live(id: string): LiveTurn | null {
    return this.#chats.get(id)?.live ?? null;
  }

  /** Aborts chat `id`'s running turn, resolving once what it said is stored. */
  async stop(id: string): Promise<void> {
    const chat = this.#chats.get(id);
    if (chat === undefined || chat.live === null) {
      // Only to answer 404 for a chat that isn't there.
      await this.store.summary(id);
      return;
    }
    await this.#interrupt(chat);
  }

  async rename(id: string, title: string): Promise<void> {
    await this.#append(id, this.#chat(id), [{ type: "title", title }]);
  }

  /** Stops any turn, then removes the chat's folder. */
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
   * The stop hook: aborts every turn and the tools they left running, and waits briefly for each
   * turn to store what it said.
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

  async #interrupt(chat: Chat): Promise<void> {
    const live = chat.live;
    if (live === null) return;
    live.controller.abort();
    await live.ended;
  }

  /** Runs `persona`'s turn on the log as stored, storing its events before `live` carries them. */
  async #reply(
    id: string,
    chat: Chat,
    live: LiveTurn,
    persona: ParticipantId,
    kickoff: boolean,
  ): Promise<void> {
    let turn: string | null = null;
    let ended = false;
    try {
      const request: TurnRequest = {
        chat: await this.store.read(id),
        persona,
        viewer: localViewer(),
        kickoff,
        signal: live.controller.signal,
        late: {
          signal: chat.cancel.signal,
          add: (name, events) => this.#late(id, chat, name, events),
        },
      };
      const save: EngineDeps["saveAttachment"] = (bytes, mime) =>
        this.store.saveFile(id, bytes, mime);
      for await (const output of this.#turn(request, save)) {
        if (output.type === "events") {
          live.push({ type: "events", events: await this.#append(id, chat, output.events) });
          continue;
        }
        if (output.type === "started") turn = output.turn;
        if (output.type === "ended") ended = true;
        live.push(output);
      }
    } catch (error) {
      await this.#failed(id, chat, live, persona, turn, error);
    } finally {
      if (turn !== null && !ended) live.push({ type: "ended", turn });
      if (chat.live === live) chat.live = null;
      live.end();
    }
  }

  /**
   * Stores what a tool an interrupted turn left running brings, through the chat's queue so it never
   * lands between a send's line and its decision. A deleted chat's is dropped.
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

  /** A turn that threw, rather than reporting its failure: stored as turn-failed if it can be. */
  async #failed(
    id: string,
    chat: Chat,
    live: LiveTurn,
    persona: ParticipantId,
    turn: string | null,
    error: unknown,
  ): Promise<void> {
    logger.exception(`Chat ${id}: ${persona}'s turn failed`, error);
    try {
      const events = await this.#append(id, chat, [
        { type: "turn-failed", persona, turn: turn ?? Bun.randomUUIDv7(), error: errorText(error) },
      ]);
      live.push({ type: "events", events });
    } catch (storing) {
      logger.exception(`Chat ${id}: the failed turn wasn't stored`, storing);
      live.push({
        type: "error",
        code: "internal",
        message: "Eidolon hit an error; the terminal has the details",
      });
    }
  }
}
