// Follows the chat on screen: its running turn from GET live when it opens, and each reply a send
// starts. A dropped stream leaves the turn running on the server, so live picks it up again once.
import type { ChatEvent, ChatStreamLine } from "@eidolon/chat";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { asApiError } from "@/lib/api";
import { followLive, sendMessage, stopChat } from "@/lib/chats";
import { toastError } from "@/lib/feedback";
import { chatQuery, chatsQuery } from "./queries";
import { IDLE, type LiveState, mergeEvents, reaches, reduceLive, Sends } from "./stream";

type Open = (signal: AbortSignal) => AsyncIterable<ChatStreamLine>;

export interface ChatTurns {
  readonly live: LiveState;
  /** A line is on its way to the log, or a reply is under way. */
  readonly busy: boolean;
  send(text: string): void;
  stop(): void;
}

export function useChat(id: string): ChatTurns {
  const queryClient = useQueryClient();
  const [live, dispatch] = useReducer(reduceLive, IDLE);
  const streams = useRef(new Set<AbortController>());
  const sends = useRef(new Sends());

  const store = useCallback(
    (events: readonly ChatEvent[]) => {
      let gap = true;
      queryClient.setQueryData(chatQuery(id).queryKey, (log) => {
        if (log === undefined) return log;
        const merged = mergeEvents(log, events);
        gap = merged.gap;
        return merged.log;
      });
      if (gap) void queryClient.invalidateQueries({ queryKey: chatQuery(id).queryKey });
      // The list shows the last message; the end of the stream refreshes it for the rest.
      if (events.some((event) => event.type === "message")) {
        void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
      }
    },
    [queryClient, id],
  );

  /** Reads one stream; `key` names the send it answers, null for live. */
  const follow: (open: Open, key: number | null, rejoin: boolean) => Promise<void> = useCallback(
    async (open: Open, key: number | null, rejoin: boolean): Promise<void> => {
      const controller = new AbortController();
      streams.current.add(controller);
      const opened = sends.current.mark(key);
      let turn: string | null = null;
      let ended = false;
      let broke = false;
      let following = false;
      const carry = () => {
        if (following) return;
        following = true;
        dispatch({ type: "follow" });
      };
      if (key !== null) carry();
      try {
        for await (const line of open(controller.signal)) {
          carry();
          if (key !== null) sends.current.accept(key);
          const reached = reaches(line, sends.current.superseded(opened));
          if (line.type === "events") store(line.events);
          else if (line.type === "started" && reached) [turn, ended] = [line.turn, false];
          else if (line.type === "ended" && line.turn === turn) ended = true;
          if (reached) dispatch(line);
        }
      } catch (error) {
        broke = !controller.signal.aborted;
        // Live failing leaves the log as stored, which the refetch below shows.
        if (key !== null && !controller.signal.aborted) {
          const { code, message } = asApiError(error);
          dispatch({ type: "send-failed", key, error: { code, message } });
        }
      } finally {
        streams.current.delete(controller);
        if (following) dispatch({ type: "unfollow" });
      }
      if (controller.signal.aborted) return;
      dispatch({ type: "settled", key, turn: null });
      // The log a turn ends with, and a turn that ended between the page's two requests.
      void queryClient.invalidateQueries({ queryKey: chatQuery(id).queryKey });
      void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
      // A group's reply goes on past a turn's end, so a stream that broke after one may have more.
      if (turn !== null && (!ended || broke)) {
        if (rejoin && !sends.current.superseded(opened)) {
          await follow((signal) => followLive(id, signal), null, false);
        }
        dispatch({ type: "settled", key: null, turn });
      }
    },
    [queryClient, id, store],
  );

  useEffect(() => {
    const open = streams.current;
    void follow((signal) => followLive(id, signal), null, true);
    return () => {
      for (const controller of open) controller.abort();
      open.clear();
    };
  }, [id, follow]);

  const send = useCallback(
    (text: string) => {
      const key = sends.current.issue();
      const after = queryClient.getQueryData(chatQuery(id).queryKey)?.events.at(-1)?.seq ?? 0;
      dispatch({ type: "sending", key, after, text });
      void follow((signal) => sendMessage(id, text, signal), key, true);
    },
    [queryClient, id, follow],
  );

  const stop = useCallback(() => {
    stopChat(id).catch(toastError);
  }, [id]);

  const busy =
    live.following > 0 || live.turn !== null || live.pending.some((line) => !line.failed);
  return { live, busy, send, stop };
}
