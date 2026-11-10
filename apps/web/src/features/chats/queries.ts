import type { ParticipantId } from "@eidolon/chat";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  changeParticipants,
  createChat,
  deleteChat,
  listChats,
  readChat,
  renameChat,
  setChainLimit,
} from "@/lib/chats";
import { toastError } from "@/lib/feedback";
import { latePoll } from "./stream";

export const chatsQuery = queryOptions({
  queryKey: ["chats"],
  queryFn: ({ signal }) => listChats(signal),
});

export function chatQuery(id: string) {
  return queryOptions({
    queryKey: ["chats", id],
    queryFn: ({ signal }) => readChat(id, signal),
    refetchInterval: (query) => latePoll(query.state.data),
  });
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { readonly id: string; readonly title: string }) =>
      renameChat(id, title),
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
      void queryClient.invalidateQueries({ queryKey: chatQuery(id).queryKey });
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
