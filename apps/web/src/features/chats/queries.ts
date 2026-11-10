import type { ParticipantId } from "@eidolon/chat";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { createChat, deleteChat, listChats, readChat, renameChat } from "@/lib/chats";
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
    mutationFn: (persona: ParticipantId) => createChat(persona),
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
