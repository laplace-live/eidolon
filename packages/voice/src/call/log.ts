// A call's chat log: each batch numbered and timed the moment the Floor appends it, so the next
// turn's view has it, and written to its store behind, in order.
import {
  type ChatEvent,
  type ChatEventDraft,
  type ChatHeader,
  MemoryChatStore,
  stampEvents,
} from "@eidolon/chat";
import { errorText, logger } from "@eidolon/config";
import type { CallLog } from "../types.ts";

/**
 * The log of `chat`, which `persist` writes on from: it gets each stamped batch once the one
 * before it has been written. A batch that fails to write is logged and stays in the call.
 */
export function callLog(
  chat: { readonly header: ChatHeader; readonly events: readonly ChatEvent[] },
  persist: (events: readonly ChatEvent[]) => Promise<void>,
): CallLog {
  const { header } = chat;
  const events = [...chat.events];
  let written: Promise<void> = Promise.resolve();
  const write = (batch: readonly ChatEvent[]): void => {
    written = written
      .then(() => persist(batch))
      .catch((error: unknown) => {
        logger.error(`[voice] Call ${header.id}'s log lost events: ${errorText(error)}`, error);
      });
  };
  return {
    snapshot: () => ({ header, events: [...events] }),
    append(drafts: readonly ChatEventDraft[]): readonly ChatEvent[] {
      if (drafts.length === 0) return [];
      const stamped = stampEvents(drafts, events.at(-1)?.seq ?? 0, Date.now());
      events.push(...stamped);
      write(stamped);
      return stamped;
    },
    flush: () => written,
  };
}

/**
 * A call log kept in memory and dropped at the call's end, as production keeps no chats; it opens
 * on `events`, a chat's as stored, whose seqs it numbers on from.
 */
export function memoryCallLog(header: ChatHeader, events: readonly ChatEvent[] = []): CallLog {
  const store = new MemoryChatStore();
  const created = (async () => {
    await store.create(header);
    if (events.length > 0) await store.append(header.id, events);
  })();
  // Each batch written after it reports its failure.
  created.catch(() => {});
  return callLog({ header, events }, async (events) => {
    await created;
    await store.append(header.id, events);
  });
}
