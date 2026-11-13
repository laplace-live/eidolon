// Browser chat session orchestration: stores each answer as it arrives, fetches her files before
// they expire, serializes turns and calls per chat with Web Locks, and stores call lines in the chat.

import {
  type FetchLike,
  fetchChatFile,
  normalizeBaseUrl,
  streamTurn,
  streamVoice,
} from "./client.ts";
import { ChatBusyError, holdChatLock, withChatLock } from "./lock.ts";
import { herAttachments, newChatHeader } from "./log.ts";
import { chatLineEventOf, isChatEvent } from "./parse.ts";
import {
  type BrowserChatRecord,
  type BrowserChatStore,
  type CallEndReason,
  ChatStoreError,
  type ChatStreamLine,
  type ChatWindow,
  type OwnEventDraft,
  type ParticipantId,
  type WireEvent,
} from "./types.ts";
import { uuidv7 } from "./uuid.ts";

export interface ChatSessionOptions<TRecord extends BrowserChatRecord = BrowserChatRecord> {
  readonly store: BrowserChatStore<TRecord>;
  /** The Login Sync token a call sends; absent or blank is anonymous. */
  readonly loginSyncToken?: string | null;
  readonly fetch?: FetchLike;
  /** Attachment files that couldn't be stored or fetched once a turn or call line settles. */
  readonly onMissingFiles?: (names: string[]) => void;
}

/** Creates a new chat with `participants`, bound to the Eidolon server at `baseUrl`. */
export function createChat<TRecord extends BrowserChatRecord>(
  store: BrowserChatStore<TRecord>,
  participants: readonly ParticipantId[],
  baseUrl: string,
  now: number = Date.now(),
): Promise<TRecord> {
  return store.create(newChatHeader(participants, now), normalizeBaseUrl(baseUrl));
}

async function chatOf<TRecord extends BrowserChatRecord>(
  store: BrowserChatStore<TRecord>,
  chatId: string,
): Promise<TRecord> {
  const chat = await store.get(chatId);
  if (chat === null) throw new ChatStoreError("not-found", `chat ${chatId} doesn't exist`);
  return chat;
}

async function endOpenCall<TRecord extends BrowserChatRecord>(
  store: BrowserChatStore<TRecord>,
  chat: TRecord,
): Promise<boolean> {
  if (chat.openCall === null) return false;
  await store.appendOwn(chat.id, [{ type: "call-ended", call: chat.openCall, reason: "error" }]);
  return true;
}

/**
 * Stores a `call-ended` for a call the log leaves open with no tab holding it. Resolves whether it
 * did; false while a call or turn holds the chat.
 */
export async function closeDanglingCall<TRecord extends BrowserChatRecord>(
  store: BrowserChatStore<TRecord>,
  chatId: string,
): Promise<boolean> {
  try {
    return await withChatLock(chatId, async () => endOpenCall(store, await chatOf(store, chatId)));
  } catch (error) {
    if (error instanceof ChatBusyError) return false;
    throw error;
  }
}

/** Stores the browser's own events (title, participants, settings) once the chat is free. */
export function writeOwnEvents<TRecord extends BrowserChatRecord>(
  store: BrowserChatStore<TRecord>,
  chatId: string,
  drafts: readonly OwnEventDraft[],
): Promise<WireEvent[]> {
  return withChatLock(chatId, () => store.appendOwn(chatId, drafts), { wait: true });
}

function herFileNames(events: readonly WireEvent[]): string[] {
  return herAttachments(events).map((attachment) => attachment.name);
}

function reportMissing(
  downloads: readonly Promise<string[]>[],
  callback: ((names: string[]) => void) | undefined,
): void {
  if (downloads.length === 0) return;
  void Promise.all(downloads)
    .then((lists) => {
      const missing = lists.flat();
      if (missing.length > 0) callback?.(missing);
    })
    .catch(() => {});
}

const inFlight = new WeakMap<object, Map<string, Promise<boolean>>>();

function downloadFile<TRecord extends BrowserChatRecord>(
  options: ChatSessionOptions<TRecord>,
  chat: Pick<BrowserChatRecord, "id" | "baseUrl">,
  name: string,
): Promise<boolean> {
  const downloads = inFlight.get(options.store) ?? new Map<string, Promise<boolean>>();
  inFlight.set(options.store, downloads);
  const key = `${chat.id}/${name}`;
  const running = downloads.get(key);
  if (running !== undefined) return running;
  const download = fetchChatFile({ baseUrl: chat.baseUrl, name, fetch: options.fetch })
    .then(async (blob) => blob !== null && (await options.store.putFile(chat.id, name, blob)))
    .catch(() => false)
    .finally(() => downloads.delete(key));
  downloads.set(key, download);
  return download;
}

/** Fetches each file into the chat; resolves to the names that expired or failed. */
export async function downloadFiles<TRecord extends BrowserChatRecord>(
  options: ChatSessionOptions<TRecord>,
  chat: Pick<BrowserChatRecord, "id" | "baseUrl">,
  names: readonly string[],
): Promise<string[]> {
  const stored = await Promise.all(names.map((name) => downloadFile(options, chat, name)));
  return names.filter((_, i) => stored[i] !== true);
}

/** Fetches her files the chat names that this browser lacks; resolves to those still missing. */
export async function downloadMissingFiles<TRecord extends BrowserChatRecord>(
  options: ChatSessionOptions<TRecord>,
  chatId: string,
): Promise<string[]> {
  const chat = await chatOf(options.store, chatId);
  return downloadFiles(options, chat, await options.store.missingFiles(chatId));
}

async function keepRecording<TRecord extends BrowserChatRecord>(
  store: BrowserChatStore<TRecord>,
  chatId: string,
  events: readonly WireEvent[],
  audio: Blob,
): Promise<string[]> {
  const missing: string[] = [];
  for (const event of events) {
    if (!isChatEvent(event) || event.type !== "message" || event.speaker.kind !== "user") continue;
    const [clip] = event.attachments ?? [];
    if (event.modality === "voice" && clip?.kind === "audio") {
      const kept = await store.putFile(chatId, clip.name, audio).catch(() => false);
      if (!kept) missing.push(clip.name);
    }
  }
  return missing;
}

export interface SendTurnInput {
  readonly chatId: string;
  /** The viewer's line, checked with `chatTextOf`; with neither it nor `voice`, her greeting. */
  readonly text?: string;
  /** A recorded voice message instead of a line. */
  readonly voice?: { readonly audio: Blob; readonly durationMs: number };
  readonly signal?: AbortSignal;
  /** Each line as it arrives; an `events` line once its events are stored. */
  readonly onLine?: (line: ChatStreamLine) => void;
  /** Attachment files that couldn't be stored or fetched once the answer settles. */
  readonly onMissingFiles?: (names: string[]) => void;
}

export interface TurnResult {
  /** What the answer added, in order, as stored. */
  readonly events: readonly WireEvent[];
}

/**
 * Sends a line, a voice message or a greeting request with the chat's newest events, storing each
 * `events` line before reading on. Rejects with `ChatBusyError`, `ChatRequestError`, or the
 * signal's `AbortError`; events stored before then stay.
 */
export async function sendChatTurn<TRecord extends BrowserChatRecord>(
  options: ChatSessionOptions<TRecord>,
  input: SendTurnInput,
): Promise<TurnResult> {
  const { store } = options;
  const { chatId, voice } = input;
  const stored: WireEvent[] = [];
  const downloads: Promise<string[]>[] = [];
  try {
    await withChatLock(chatId, async () => {
      const chat = await chatOf(store, chatId);
      await endOpenCall(store, chat);
      const request = {
        baseUrl: chat.baseUrl,
        chat: await store.window(chatId),
        loginSyncToken: options.loginSyncToken,
        signal: input.signal,
        fetch: options.fetch,
      };
      const lines =
        voice === undefined
          ? streamTurn({ ...request, text: input.text })
          : streamVoice({ ...request, audio: voice.audio, durationMs: voice.durationMs });
      for await (const line of lines) {
        if (line.type === "events") {
          await store.append(chatId, line.events);
          if (voice !== undefined && stored.length === 0) {
            const missingRecording = await keepRecording(store, chatId, line.events, voice.audio);
            if (missingRecording.length > 0) {
              downloads.push(Promise.resolve(missingRecording));
            }
          }
          stored.push(...line.events);
          const names = herFileNames(line.events);
          if (names.length > 0) {
            downloads.push(downloadFiles(options, chat, names));
          }
        }
        input.onLine?.(line);
      }
    });
  } finally {
    reportMissing(downloads, input.onMissingFiles ?? options.onMissingFiles);
  }
  return { events: stored };
}

/** A call inside a chat, holding the chat's lock until it ends. */
export interface ChatCall {
  readonly id: string;
  readonly persona: ParticipantId;
  /** The offer's `requestData.chat`, with this call's `call-started` last. */
  readonly window: ChatWindow;
  /** Stores an RTVI server message when it is a `chat-line`, and fetches its photos. */
  receive(data: unknown): Promise<boolean>;
  /** Stores `call-ended` after the lines received, then frees the chat for turns. */
  end(reason: CallEndReason): Promise<void>;
}

async function openCall<TRecord extends BrowserChatRecord>(
  store: BrowserChatStore<TRecord>,
  chatId: string,
  persona: ParticipantId,
): Promise<{ chat: TRecord; callId: string; window: ChatWindow }> {
  const chat = await chatOf(store, chatId);
  if (!chat.participants.includes(persona)) {
    throw new ChatStoreError("invalid", `${persona} isn't in the chat`);
  }
  await endOpenCall(store, chat);
  const callId = uuidv7();
  await store.appendOwn(chatId, [{ type: "call-started", call: callId, persona }]);
  return { chat, callId, window: await store.window(chatId) };
}

/**
 * Opens a call to `persona` in the chat: stores its `call-started` and holds the chat's lock so no
 * turn runs during it. Rejects with `ChatBusyError` while held, or `invalid` when `persona` isn't
 * in the chat.
 */
export async function startChatCall<TRecord extends BrowserChatRecord>(
  options: ChatSessionOptions<TRecord>,
  chatId: string,
  persona: ParticipantId,
): Promise<ChatCall> {
  const { store } = options;
  const release = await holdChatLock(chatId);
  const { chat, callId, window } = await openCall(store, chatId, persona).catch(
    (error: unknown) => {
      release();
      throw error;
    },
  );
  let lines: Promise<void> = Promise.resolve();
  let ending: Promise<void> | null = null;
  return {
    id: callId,
    persona,
    window,
    receive(data) {
      const event = chatLineEventOf(data);
      if (event === null || ending !== null) return Promise.resolve(false);
      const stored = lines.then(() => store.append(chatId, [event], { allowGap: true }));
      lines = stored.then(
        () => {
          const names = herFileNames([event]);
          if (names.length > 0) {
            reportMissing([downloadFiles(options, chat, names)], options.onMissingFiles);
          }
        },
        () => {},
      );
      return stored.then(() => true);
    },
    end(reason) {
      ending ??= lines
        .then(() => store.appendOwn(chatId, [{ type: "call-ended", call: callId, reason }]))
        .then(() => {})
        .finally(release);
      return ending;
    },
  };
}
