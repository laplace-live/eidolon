// Notifications of her chat replies while the window isn't focused: polls the chat list, reads
// newly advanced chats for persona messages (text, voice or photos), and emits single or group
// notices whose click opens the chat. Electron-free: index.ts drives it through native.ts.
import type { ChatEvent, ChatSummary } from "../../../../packages/chat/src/format.ts";
import type { PersonasResponse } from "../../../bot/src/local/api.ts";
import { type DesktopCommand, openChatCommand } from "../shared/bridge.ts";
import type { NoticeHandle } from "./background.ts";
import type { BackendFetch } from "./quit-check.ts";
import type { Strings } from "./strings.ts";

export interface ChatNotice {
  readonly chat: string;
  readonly seq: number;
  readonly speakerId: string;
  readonly speakerName: string;
  /** Non-null in a group chat (2+ participants). */
  readonly groupTitle: string | null;
  /** Up to 2 other participant ids in a group chat; empty in a single chat. */
  readonly groupPeers: readonly string[];
  readonly body: string;
}

export interface ChatWatchOptions {
  /** A GET to the server ready now (Backend.get), Bearer included. */
  readonly fetch: BackendFetch;
  /** Whether the window is focused now. */
  readonly focused: () => boolean;
  readonly strings: () => Strings;
  /** Shows a chat notice; null when notifications can't show. */
  readonly show: (notice: ChatNotice) => NoticeHandle | null;
  readonly log: { info(message: string): void; warn(message: string): void };
  /** Tests' clock. */
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

interface PersonaNames {
  readonly name: string;
  readonly shortName: string;
}

const CHATS = "/api/local/chats";
const PERSONAS = "/api/local/personas";
const POLL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BODY_CHARS = 120;
const GROUP_TITLE_CHARS = 80;
const MAX_HANDLES = 32;

// Mirrors packages/sdk/src/markup.ts so apps/desktop keeps zero runtime package imports.
const CUE_EMOJI: ReadonlyMap<string, string> = new Map<string, string>([
  ["chuckling", "😄"],
  ["laughing", "😆"],
  ["sighing", "😮‍💨"],
  ["gasping", "😯"],
  ["panting", "🥵"],
  ["yawning", "🥱"],
  ["groaning", "😩"],
  ["snoring", "😴"],
  ["sobbing", "😭"],
  ["crying loudly", "😭"],
  ["happy", "😊"],
  ["excited", "🤩"],
  ["delighted", "😃"],
  ["satisfied", "😋"],
  ["relaxed", "😎"],
  ["grateful", "🙏"],
  ["proud", "🥹"],
  ["moved", "🥹"],
  ["calm", "😌"],
  ["curious", "🤨"],
  ["empathetic", "🥺"],
  ["sympathetic", "🥺"],
  ["compassionate", "🤗"],
  ["surprised", "😲"],
  ["embarrassed", "😳"],
  ["nostalgic", "🥲"],
  ["lonely", "😔"],
  ["regretful", "😣"],
  ["disappointed", "😞"],
  ["uncertain", "😕"],
  ["confused", "😕"],
  ["doubtful", "🤔"],
  ["worried", "😟"],
  ["hopeful", "🤞"],
  ["optimistic", "🌞"],
  ["sarcastic", "😏"],
  ["confident", "😎"],
  ["determined", "😤"],
  ["indifferent", "😐"],
  ["sad", "😢"],
  ["angry", "😠"],
  ["frustrated", "😖"],
  ["unhappy", "🙁"],
  ["in a hurry tone", "⏱️"],
  ["shouting", "📢"],
  ["screaming", "😱"],
  ["whispering", "🤫"],
  ["soft tone", "🥰"],
]);
const PAUSES = new Set(["break", "long-break"]);
const MARKUP = /\[([^[\]\n]+)\]|<(\/?)([A-Za-z]+)>/g;
const TRAILING_PARTIAL_CUE = /(\[[^[\]\n]*|<\/?[A-Za-z]*)$/;

function spacesAt(text: string, from: number): number {
  let end = from;
  while (end < text.length && " \t\u3000".includes(text[end] ?? "")) end++;
  return end - from;
}

/** Single-line plain text matching apps/web's `previewText` without importing `@laplace.live/eidolon-sdk`. */
export function plainReplyText(text: string): string {
  const source = text.replace(TRAILING_PARTIAL_CUE, "");
  let out = "";
  let cursor = 0;
  for (const match of source.matchAll(MARKUP)) {
    const [whole, cue] = match;
    const index = match.index ?? 0;
    if (index > cursor) out += source.slice(cursor, index);
    cursor = index + whole.length;
    if (cue !== undefined) {
      const inner = cue.trim();
      const name = inner.toLowerCase();
      const emoji = CUE_EMOJI.get(name);
      if (emoji !== undefined) out += emoji;
      else if (inner !== "" && !PAUSES.has(name)) out += " ";
      else cursor += spacesAt(source, cursor);
    }
  }
  if (cursor < source.length) out += source.slice(cursor);
  return out.replace(/\s+/g, " ").trim();
}

const CONTROL_OR_FORMAT = /[\p{Cc}\u2028\u2029]|(?!\u200D)\p{Cf}/gu;
const CONTROL_ONLY = /[\p{Cc}\u2028\u2029]/gu;

function sanitizeAndClip(raw: string, limit: number, stripFormat = true): string {
  const line = raw
    .replace(stripFormat ? CONTROL_OR_FORMAT : CONTROL_ONLY, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...line];
  return chars.length > limit ? `${chars.slice(0, limit).join("").trimEnd()}…` : line;
}

function chatsOf(answer: unknown): ChatSummary[] {
  if (!Array.isArray(answer)) throw new Error(`GET ${CHATS}: no chat list`);
  return (answer as (Partial<ChatSummary> | null)[]).filter(
    (chat): chat is ChatSummary =>
      typeof chat?.id === "string" &&
      Array.isArray(chat.participants) &&
      typeof chat.lastSeq === "number",
  );
}

function eventsOf(answer: unknown, path: string): ChatEvent[] {
  const { events } = (answer ?? {}) as { events?: unknown };
  if (!Array.isArray(events)) throw new Error(`GET ${path}: no event list`);
  return events as ChatEvent[];
}

function personasOf(answer: unknown): Map<string, PersonaNames> {
  const { personas } = (answer ?? {}) as Partial<PersonasResponse>;
  if (!Array.isArray(personas)) throw new Error(`GET ${PERSONAS}: no persona list`);
  return new Map(
    personas.flatMap(({ id, name, shortName }) =>
      typeof id === "string" && typeof name === "string"
        ? [[id, { name, shortName: typeof shortName === "string" ? shortName : "" }] as const]
        : [],
    ),
  );
}

async function read(fetch: BackendFetch, path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return await response.json();
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function explain(error: unknown): string {
  const messages: string[] = [];
  for (let at = error; at !== undefined; at = at instanceof Error ? at.cause : undefined) {
    messages.push(at instanceof Error ? at.message : String(at));
  }
  return messages.join(": ");
}

function groupMetadata(
  summary: ChatSummary,
  speakerId: string,
  names: ReadonlyMap<string, PersonaNames> | null,
  strings: Strings,
): { readonly groupTitle: string; readonly groupPeers: readonly string[] } | null {
  if (summary.participants.length < 2) return null;
  const named = sanitizeAndClip(summary.title ?? "", GROUP_TITLE_CHARS);
  const title =
    named !== ""
      ? named
      : sanitizeAndClip(
          summary.participants
            .map((id) => {
              const info = names?.get(id);
              return info?.shortName.trim() || info?.name.trim() || id;
            })
            .join(strings.chatNotice.listSeparator),
          GROUP_TITLE_CHARS,
          false,
        );
  const peers = summary.participants.filter((id) => id !== speakerId).slice(0, 2);
  return { groupTitle: title, groupPeers: peers };
}

interface PendingMessage {
  readonly summary: ChatSummary;
  readonly seq: number;
  readonly speakerId: string;
  readonly text: string;
  readonly modality?: "text" | "voice" | "call";
  readonly imageCount: number;
}

/**
 * Polls the ready server's chats and notifies of new persona replies while the window isn't
 * focused. The first answer after ready() sets the baseline and notifies nothing.
 */
export class ChatWatch {
  readonly #options: ChatWatchOptions;
  readonly #timers: NonNullable<ChatWatchOptions["timers"]>;
  #run: object | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #requests = new Set<AbortController>();
  #seen = new Map<string, number>();
  #chats = new Map<string, ChatSummary>();
  #baseline = false;
  #personas: ReadonlyMap<string, PersonaNames> | null = null;
  /** Retain recent handles so Electron does not GC click callbacks while banners are visible. */
  readonly #shown = new Map<string, NoticeHandle>();
  #failing = false;

  constructor(options: ChatWatchOptions) {
    this.#options = options;
    this.#timers = options.timers ?? globalThis;
  }

  /** A server is ready (owned or attached): a new baseline, then polls. */
  ready(): void {
    this.stop();
    const run = {};
    this.#run = run;
    this.#baseline = true;
    this.#personas = null;
    this.#chats.clear();
    this.#failing = false;
    this.#schedule(run, 0);
  }

  /** No server is ready, or Eidolon quits: stops polling. */
  stop(): void {
    this.#run = null;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const request of this.#requests) request.abort();
    this.#requests.clear();
  }

  /**
   * Returns `{ groupTitle, groupPeers }` if `chatId` was last seen with 2+ participants, fetching
   * persona short names if the group has no custom title and names aren't cached yet.
   */
  async groupFor(
    chatId: string,
    speakerId: string,
  ): Promise<{ readonly groupTitle: string; readonly groupPeers: readonly string[] } | null> {
    const summary = this.#chats.get(chatId);
    if (summary === undefined || summary.participants.length < 2) return null;
    const run = this.#run;
    const names =
      (summary.title ?? "").trim() !== "" || run === null
        ? this.#personas
        : await this.#personaNames(run, summary.participants);
    return groupMetadata(summary, speakerId, names, this.#options.strings());
  }

  #schedule(run: object, delay: number): void {
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      void this.#poll(run);
    }, delay);
  }

  async #poll(run: object): Promise<void> {
    try {
      const list = chatsOf(await this.#get(CHATS));
      if (this.#failing) {
        this.#failing = false;
        this.#options.log.info("Eidolon: chat notifications read the chats again");
      }
      await this.#take(run, list);
    } catch (error) {
      if (this.#run !== run) return;
      if (!this.#failing) {
        this.#failing = true;
        this.#options.log.warn(
          `Eidolon: chat notifications couldn't read the chats: ${explain(error)}`,
        );
      }
    }
    if (this.#run === run) this.#schedule(run, POLL_MS);
  }

  async #take(run: object, list: readonly ChatSummary[]): Promise<void> {
    this.#chats = new Map(list.map((chat) => [chat.id, chat]));
    if (this.#baseline) {
      this.#baseline = false;
      this.#seen = new Map(list.map((chat) => [chat.id, chat.lastSeq]));
      return;
    }

    const advanced = list.filter((chat) => chat.lastSeq > (this.#seen.get(chat.id) ?? 0));
    if (advanced.length === 0 || this.#options.focused()) {
      this.#seen = new Map(list.map((chat) => [chat.id, chat.lastSeq]));
      return;
    }

    const pending: PendingMessage[] = [];
    const readMax = new Map<string, number>();
    const fetched = await Promise.all(
      advanced.map(async (chat) => {
        const prev = this.#seen.get(chat.id) ?? 0;
        const path = `${CHATS}/${encodeURIComponent(chat.id)}?afterSeq=${prev}`;
        return { chat, events: eventsOf(await this.#get(path), path) };
      }),
    );
    if (this.#run !== run) return;
    for (const { chat, events } of fetched) {
      const lastEventSeq = events.at(-1)?.seq ?? 0;
      readMax.set(chat.id, Math.max(chat.lastSeq, lastEventSeq));
      for (const event of events) {
        if (
          event.type === "message" &&
          event.speaker.kind === "persona" &&
          event.modality !== "call" &&
          event.interrupted !== true
        ) {
          const imageCount = event.attachments?.filter((file) => file.kind === "image").length ?? 0;
          pending.push({
            summary: chat,
            seq: event.seq,
            speakerId: event.speaker.id,
            text: event.text,
            modality: event.modality,
            imageCount,
          });
        }
      }
    }

    const updateSeen = () => {
      const next = new Map<string, number>();
      for (const chat of list) {
        next.set(chat.id, Math.max(chat.lastSeq, readMax.get(chat.id) ?? 0));
      }
      this.#seen = next;
    };

    if (pending.length === 0 || this.#options.focused()) {
      updateSeen();
      return;
    }

    const neededIds = [
      ...new Set(pending.flatMap((item) => [item.speakerId, ...item.summary.participants])),
    ];
    const names = await this.#personaNames(run, neededIds);
    if (this.#run !== run) return;
    updateSeen();
    if (this.#options.focused()) return;

    const strings = this.#options.strings();
    for (const item of pending) {
      const body = this.#bodyFor(item, strings);
      if (body === "") continue;
      const speaker = names?.get(item.speakerId);
      const speakerName = speaker?.name.trim() || speaker?.shortName.trim() || item.speakerId;
      const group = groupMetadata(item.summary, item.speakerId, names, strings);
      const handle = this.#options.show({
        chat: item.summary.id,
        seq: item.seq,
        speakerId: item.speakerId,
        speakerName,
        groupTitle: group?.groupTitle ?? null,
        groupPeers: group?.groupPeers ?? [],
        body,
      });
      if (handle !== null) this.#keepHandle(`${item.summary.id}:${item.seq}`, handle);
    }
  }

  #bodyFor(item: PendingMessage, strings: Strings): string {
    const line = sanitizeAndClip(plainReplyText(item.text), BODY_CHARS);
    if (line !== "") return line;
    if (item.modality === "voice") return strings.chatNotice.voice;
    if (item.imageCount === 1) return strings.chatNotice.photo;
    if (item.imageCount > 1) return strings.chatNotice.photos(item.imageCount);
    return "";
  }

  #keepHandle(key: string, handle: NoticeHandle): void {
    this.#shown.delete(key);
    this.#shown.set(key, handle);
    while (this.#shown.size > MAX_HANDLES) {
      const oldest = this.#shown.keys().next().value;
      if (oldest === undefined) break;
      this.#shown.delete(oldest);
    }
  }

  async #personaNames(
    run: object,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, PersonaNames> | null> {
    const known = this.#personas;
    if (ids.every((id) => known?.has(id) === true)) return known;
    try {
      this.#personas = personasOf(await this.#get(PERSONAS));
    } catch (error) {
      if (this.#run === run) {
        this.#options.log.warn(
          `Eidolon: chat notifications couldn't read the personas' names: ${explain(error)}`,
        );
      }
    }
    return this.#personas;
  }

  async #get(path: string): Promise<unknown> {
    const request = new AbortController();
    this.#requests.add(request);
    const timer = this.#timers.setTimeout(
      () => request.abort(new Error(`no answer in ${REQUEST_TIMEOUT_MS / 1000} s`)),
      REQUEST_TIMEOUT_MS,
    );
    try {
      return await Promise.race([
        read(this.#options.fetch, path, request.signal),
        aborted(request.signal),
      ]);
    } finally {
      this.#timers.clearTimeout(timer);
      request.abort();
      this.#requests.delete(request);
    }
  }
}

/** What clicking a chat notice asks of the page once the window shows. */
export function chatNoticeCommand(notice: Pick<ChatNotice, "chat">): DesktopCommand {
  return openChatCommand(notice.chat);
}
