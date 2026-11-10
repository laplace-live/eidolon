// The chats API at /api/local/chats, whose wire types carry @eidolon/chat's format.
import type { ChatStreamLine, ChatSummary, ParticipantId, ReplyMode } from "@eidolon/chat";
import { ApiError, type ChatContents, call, send, stream, url } from "./api";
import { readNdjson } from "./ndjson";

export type { ChatContents };

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamLine> {
  for await (const { value } of readNdjson<ChatStreamLine>(body)) yield value;
}

export function listChats(signal?: AbortSignal): Promise<readonly ChatSummary[]> {
  return call("GET /api/local/chats", { signal });
}

/**
 * A new chat with `participants`, 1 to 6 personas. With one, her greeting starts at once and GET
 * live streams it; a group waits for the viewer's first line.
 */
export function createChat(
  participants: readonly ParticipantId[],
): Promise<{ readonly id: string }> {
  return call("POST /api/local/chats", { body: { participants } });
}

export function readChat(id: string, signal?: AbortSignal): Promise<ChatContents> {
  return call("GET /api/local/chats/:id", { params: { id }, signal });
}

/**
 * Sends the viewer's line, interrupting any reply still running, and yields the new reply's lines.
 * Aborting `signal` only stops the reading: the reply runs on, and GET live replays it.
 */
export async function* sendMessage(
  id: string,
  text: string,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamLine> {
  yield* lines(
    await stream("POST /api/local/chats/:id/messages", { params: { id }, body: { text }, signal }),
  );
}

/**
 * Sends a recorded voice message, `durationMs` long by the recorder's clock, as sendMessage sends a
 * line: its first `events` line holds the stored message with its transcript, then the reply
 * follows.
 */
export async function* sendVoice(
  id: string,
  audio: Blob,
  durationMs: number,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamLine> {
  yield* lines(
    await stream("POST /api/local/chats/:id/voice", {
      params: { id },
      query: { durationMs: Math.max(1, Math.round(durationMs)) },
      body: audio,
      signal,
    }),
  );
}

/** The running turn's lines from its start; none when the chat is idle, which answers 204. */
export async function* followLive(id: string, signal: AbortSignal): AsyncGenerator<ChatStreamLine> {
  const response = await send("GET /api/local/chats/:id/live", { params: { id }, signal });
  if (response.status === 204) return;
  if (!response.body) throw new ApiError(response.status, "bad-response", "no body");
  yield* lines(response.body);
}

/** Resolves once the stopped reply's words are stored. */
export async function stopChat(id: string): Promise<void> {
  await send("POST /api/local/chats/:id/stop", { params: { id } });
}

export async function renameChat(id: string, title: string): Promise<void> {
  await call("PATCH /api/local/chats/:id", { params: { id }, body: { title } });
}

/** How many times personas may answer each other after each of the viewer's lines, 0 to 6. */
export async function setChainLimit(id: string, chainLimit: number): Promise<void> {
  await call("PATCH /api/local/chats/:id", { params: { id }, body: { chainLimit } });
}

/** How every persona in the chat answers from the next line on, over each one's own setting. */
export async function setReplyMode(id: string, replyMode: ReplyMode): Promise<void> {
  await call("PATCH /api/local/chats/:id", { params: { id }, body: { replyMode } });
}

/** Adds personas to the chat and removes others, leaving it 1 to 6. */
export async function changeParticipants(
  id: string,
  change: { readonly add?: readonly ParticipantId[]; readonly remove?: readonly ParticipantId[] },
): Promise<void> {
  await call("POST /api/local/chats/:id/participants", { params: { id }, body: change });
}

export async function deleteChat(id: string): Promise<void> {
  await call("DELETE /api/local/chats/:id", { params: { id } });
}

/** An attachment's path, which an <img> or <audio> loads with the session cookie alone. */
export function chatFilePath(id: string, name: string): string {
  return url("GET /api/local/chats/:id/files/:name", { params: { id, name } });
}
