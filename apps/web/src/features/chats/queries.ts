import type {
  ChatDisplay,
  ChatEvent,
  ParticipantId,
  PermissionLevel,
  ReplyMode,
} from "@eidolon/chat";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  changeParticipants,
  createChat,
  deleteChat,
  type LocalChatSummary,
  listChats,
  markChatRead,
  readChat,
  renameChat,
  setChainLimit,
  setDisplay,
  setPermissions,
  setReplyMode,
} from "@/lib/chats";
import { toastError } from "@/lib/feedback";
import { latePoll } from "./stream";

/** Poll the chat list more often while any chat has a turn, upload or call running. */
export const CHATS_ACTIVE_POLL_MS = 2000;
export const CHATS_IDLE_POLL_MS = 15_000;

export function chatsPoll(
  chats: readonly Pick<LocalChatSummary, "active">[] | undefined,
): number | false {
  if (chats === undefined) return false;
  return chats.some((chat) => chat.active) ? CHATS_ACTIVE_POLL_MS : CHATS_IDLE_POLL_MS;
}

export const chatsQuery = queryOptions({
  queryKey: ["chats"],
  queryFn: ({ signal }) => listChats(signal),
  refetchInterval: (query) => chatsPoll(query.state.data),
});

export function chatQuery(id: string) {
  return queryOptions({
    queryKey: ["chats", id],
    queryFn: ({ signal }) => readChat(id, signal),
    refetchInterval: (query) => latePoll(query.state.data),
  });
}

/**
 * Marks chat `id` read up to its latest stored event whenever `ready` and that seq advances,
 * clearing its cached unread badge optimistically so switching back never flashes stale counts.
 */
export function useMarkRead(
  id: string,
  events: readonly ChatEvent[] | undefined,
  ready: boolean,
): void {
  const queryClient = useQueryClient();
  const lastSeq = events?.at(-1)?.seq ?? 0;
  const marked = useRef({ id, seq: 0 });

  useEffect(() => {
    if (!ready) return;
    const current = marked.current.id === id ? marked.current.seq : 0;
    if (lastSeq <= current) return;
    marked.current = { id, seq: lastSeq };
    const chats = queryClient.getQueryData(chatsQuery.queryKey);
    const summary = chats?.find((chat) => chat.id === id);
    if (summary !== undefined && summary.unread === 0 && lastSeq <= summary.lastSeq) return;
    const clearUnread = () => {
      queryClient.setQueryData(chatsQuery.queryKey, (list) =>
        list?.some((chat) => chat.id === id && chat.unread > 0 && chat.lastSeq <= lastSeq)
          ? list.map((chat) => (chat.id === id ? { ...chat, unread: 0 } : chat))
          : list,
      );
    };
    // Cancel an in-flight list poll with cached data so its pre-read snapshot can't overwrite 0.
    const hadFetch = queryClient.isFetching({ queryKey: chatsQuery.queryKey, exact: true }) > 0;
    if (hadFetch && chats !== undefined) {
      void queryClient.cancelQueries({ queryKey: chatsQuery.queryKey, exact: true });
    }
    clearUnread();
    void markChatRead(id, lastSeq)
      .then(async () => {
        const now = queryClient.getQueryData(chatsQuery.queryKey)?.find((chat) => chat.id === id);
        const inFlight = queryClient.isFetching({ queryKey: chatsQuery.queryKey, exact: true }) > 0;
        if (now !== undefined && now.unread > 0) clearUnread();
        if (hadFetch || inFlight || (now !== undefined && now.unread > 0)) {
          const empty = queryClient.getQueryData(chatsQuery.queryKey) === undefined;
          await queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
          if (empty) {
            await queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
          }
        }
      })
      .catch(() => {
        if (marked.current.id === id && marked.current.seq === lastSeq) {
          marked.current = { id, seq: 0 };
        }
        if (hadFetch) {
          void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
        }
      });
  }, [id, lastSeq, ready, queryClient]);
}

export function useCreateChat(onCreated: (id: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (participants: readonly ParticipantId[]) => createChat(participants),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
      onCreated(id);
    },
    onError: toastError,
  });
}

export function useRenameChat(onRenamed: () => void) {
  const changed = useChanged();
  return useMutation({
    mutationFn: ({ id, title }: { readonly id: string; readonly title: string }) =>
      renameChat(id, title),
    onSuccess: (_, { id }) => {
      void changed(id);
      onRenamed();
    },
    onError: toastError,
  });
}

/** Refreshes the chat and the list after a change to the chat's log. */
function useChanged() {
  const queryClient = useQueryClient();
  return (id: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true }),
      queryClient.invalidateQueries({ queryKey: chatQuery(id).queryKey }),
    ]);
}

export function useSetChainLimit() {
  const changed = useChanged();
  return useMutation({
    mutationFn: ({ id, chainLimit }: { readonly id: string; readonly chainLimit: number }) =>
      setChainLimit(id, chainLimit),
    onSuccess: (_, { id }) => changed(id),
    onError: toastError,
  });
}

export function useSetReplyMode() {
  const changed = useChanged();
  return useMutation({
    mutationFn: ({ id, replyMode }: { readonly id: string; readonly replyMode: ReplyMode }) =>
      setReplyMode(id, replyMode),
    onSuccess: (_, { id }) => changed(id),
    onError: toastError,
  });
}

export function useSetDisplay() {
  const changed = useChanged();
  return useMutation({
    mutationFn: ({ id, display }: { readonly id: string; readonly display: ChatDisplay }) =>
      setDisplay(id, display),
    onSuccess: (_, { id }) => changed(id),
    onError: toastError,
  });
}

export function useSetPermissions() {
  const changed = useChanged();
  return useMutation({
    mutationFn: ({
      id,
      permissions,
    }: {
      readonly id: string;
      readonly permissions: PermissionLevel;
    }) => setPermissions(id, permissions),
    onSuccess: (_, { id }) => changed(id),
    onError: toastError,
  });
}

export function useChangeParticipants() {
  const changed = useChanged();
  return useMutation({
    mutationFn: ({
      id,
      ...change
    }: {
      readonly id: string;
      readonly add?: readonly ParticipantId[];
      readonly remove?: readonly ParticipantId[];
    }) => changeParticipants(id, change),
    onSuccess: (_, { id }) => changed(id),
    onError: toastError,
  });
}

export function useDeleteChat(onDeleted: (id: string) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteChat(id),
    onSuccess: (_, id) => {
      queryClient.setQueryData(chatsQuery.queryKey, (chats) =>
        chats?.filter((chat) => chat.id !== id),
      );
      void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
      onDeleted(id);
      queryClient.removeQueries({ queryKey: chatQuery(id).queryKey });
    },
    onError: toastError,
  });
}
