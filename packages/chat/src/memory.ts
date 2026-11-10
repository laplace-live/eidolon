// Chats held in memory and gone with the process: a call's log, where nothing keeps chats.
import {
  type ChatEvent,
  type ChatHeader,
  type ChatStore,
  ChatStoreError,
  type ChatSummary,
} from "./format.ts";
import { advanceSummary, summarize } from "./summary.ts";

interface Chat {
  readonly header: ChatHeader;
  readonly events: ChatEvent[];
  summary: ChatSummary;
}

export class MemoryChatStore implements ChatStore {
  readonly #chats = new Map<string, Chat>();

  async list(): Promise<ChatSummary[]> {
    return [...this.#chats.values()]
      .map((chat) => chat.summary)
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  async create(header: ChatHeader): Promise<void> {
    if (this.#chats.has(header.id)) throw new ChatStoreError("exists", `Chat ${header.id} exists`);
    this.#chats.set(header.id, { header, events: [], summary: summarize(header, []) });
  }

  async read(
    id: string,
    options: { readonly afterSeq?: number } = {},
  ): Promise<{ header: ChatHeader; events: ChatEvent[] }> {
    const chat = this.#chat(id);
    const after = options.afterSeq ?? 0;
    return { header: chat.header, events: chat.events.filter((event) => event.seq > after) };
  }

  async append(id: string, events: readonly ChatEvent[]): Promise<void> {
    const chat = this.#chat(id);
    const { lastSeq } = chat.summary;
    for (const [i, event] of events.entries()) {
      if (event.seq !== lastSeq + 1 + i) {
        throw new ChatStoreError(
          "seq-gap",
          `Event seq ${event.seq} doesn't follow ${lastSeq + i}: the log stays as it was`,
        );
      }
    }
    chat.events.push(...events);
    chat.summary = advanceSummary(chat.summary, events);
  }

  async remove(id: string): Promise<void> {
    this.#chat(id);
    this.#chats.delete(id);
  }

  #chat(id: string): Chat {
    const chat = this.#chats.get(id);
    if (chat === undefined) throw new ChatStoreError("not-found", `No chat ${id}`);
    return chat;
  }
}
