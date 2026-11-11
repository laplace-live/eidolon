// Follows the chat on screen: its running turn from GET live when it opens, each reply a send
// starts, and a call this page holds in it. A dropped stream leaves the turn running on the server,
// so live picks it up again once. Her voice messages answering a send from this tab play on their
// own, one after another, while the tab has the focus and no call is on.
import type { ChatEvent, ChatStreamLine } from "@eidolon/chat";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { asApiError } from "@/lib/api";
import { followLive, sendMessage, sendVoice, stopChat } from "@/lib/chats";
import { toastError } from "@/lib/feedback";
import { chatQuery, chatsQuery } from "./queries";
import { reread } from "./reread";
import {
  IDLE,
  type LiveState,
  mayRunOn,
  mergeEvents,
  reaches,
  reduceLive,
  Sends,
  type VoiceClip,
} from "./stream";
import { afterAutoPlay, pausePlayback, queueReplies, voiceReplies } from "./voice";

type Open = (signal: AbortSignal) => AsyncIterable<ChatStreamLine>;

/** How long a call's feed waits to ask GET live again, after a 204 or a dropped stream. */
const CALL_FEED_RETRY_MS = 2000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ChatTurns {
  readonly live: LiveState;
  /** A line is on its way to the log, or a reply is under way. */
  readonly busy: boolean;
  send(text: string): void;
  sendVoice(clip: VoiceClip): void;
  stop(): void;
  /** The seq of her voice message to play now on its own; null for none. */
  readonly autoPlay: number | null;
  /**
   * It played through or broke off, and the next waiting plays while the tab has the focus; or it
   * was paused or refused, and none of them does.
   */
  autoPlayEnded(next: boolean): void;
}

/** `calling`: a call is on in the chat, whose lines GET live carries as they are stored. */
export function useChat(id: string, calling: boolean): ChatTurns {
  const queryClient = useQueryClient();
  const [live, dispatch] = useReducer(reduceLive, IDLE);
  const streams = useRef(new Set<AbortController>());
  const sends = useRef(new Sends());
  const [toPlay, setToPlay] = useState<readonly number[]>([]);
  const callOn = useRef(calling);

  useEffect(() => {
    callOn.current = calling;
    if (!calling) return;
    pausePlayback();
    setToPlay([]);
  }, [calling]);

  const store = useCallback(
    (events: readonly ChatEvent[]) => {
      let gap = true;
      queryClient.setQueryData(chatQuery(id).queryKey, (log) => {
        if (log === undefined) return log;
        const merged = mergeEvents(log, events);
        gap = merged.gap;
        return merged.log;
      });
      if (gap) void reread(queryClient, chatQuery(id).queryKey);
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
      let received = false;
      let following = false;
      const carry = () => {
        if (following) return;
        following = true;
        dispatch({ type: "follow" });
      };
      if (key !== null) carry();
      try {
        for await (const line of open(controller.signal)) {
          received = true;
          carry();
          if (key !== null) sends.current.accept(key);
          const superseded = sends.current.superseded(opened);
          const reached = reaches(line, superseded);
          if (line.type === "events") {
            store(line.events);
            const replies = key === null || superseded ? [] : voiceReplies(line.events);
            if (replies.length > 0) {
              const state = { focused: document.hasFocus(), calling: callOn.current };
              setToPlay((waiting) => queueReplies(waiting, replies, state));
            }
          } else if (line.type === "started" && reached) [turn, ended] = [line.turn, false];
          else if (line.type === "ended" && line.turn === turn) ended = true;
          if (reached) dispatch(line.type === "events" && key !== null ? { ...line, key } : line);
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
      void reread(queryClient, chatQuery(id).queryKey);
      void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
      if (mayRunOn({ turn, ended, broke, received })) {
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

  // GET live answers 204 until the call is set up, and may drop, so it is asked again while the
  // call is on. A stream still open at the hang-up runs on to the call-ended the server stores.
  useEffect(() => {
    if (!calling) return;
    let on = true;
    void (async () => {
      while (on) {
        await follow((signal) => followLive(id, signal), null, false);
        // follow reread the log as its stream ended; only a hang-up during the pause is unread.
        if (!on) return;
        await pause(CALL_FEED_RETRY_MS);
      }
      void reread(queryClient, chatQuery(id).queryKey);
    })();
    return () => {
      on = false;
    };
  }, [calling, id, follow, queryClient]);

  const send = useCallback(
    (text: string) => {
      const key = sends.current.issue();
      const after = queryClient.getQueryData(chatQuery(id).queryKey)?.events.at(-1)?.seq ?? 0;
      dispatch({ type: "sending", key, after, text });
      void follow((signal) => sendMessage(id, text, signal), key, true);
    },
    [queryClient, id, follow],
  );

  const sendVoiceClip = useCallback(
    (clip: VoiceClip) => {
      const key = sends.current.issue();
      const after = queryClient.getQueryData(chatQuery(id).queryKey)?.events.at(-1)?.seq ?? 0;
      dispatch({ type: "sending", key, after, text: "", voice: clip });
      void follow((signal) => sendVoice(id, clip.audio, clip.durationMs, signal), key, true);
    },
    [queryClient, id, follow],
  );

  const autoPlayEnded = useCallback((next: boolean) => {
    const focused = document.hasFocus();
    setToPlay((waiting) => afterAutoPlay(waiting, next, focused));
  }, []);

  const stop = useCallback(() => {
    stopChat(id).catch(toastError);
  }, [id]);

  const busy =
    live.following > 0 || live.turn !== null || live.pending.some((line) => !line.failed);
  return {
    live,
    busy,
    send,
    sendVoice: sendVoiceClip,
    stop,
    autoPlay: calling ? null : (toPlay[0] ?? null),
    autoPlayEnded,
  };
}
