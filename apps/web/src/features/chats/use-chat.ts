// Follows the chat on screen: its running turn from GET live when it opens, each reply a send
// starts, a call in it, and her report on a task that ended. A dropped stream leaves the turn
// running on the server, so live picks it up again once. Her voice messages answering a send from
// this tab play on their own, one after another, while the tab has the focus and no call is on in
// the tab.
import type { Attachment, ChatEvent, ChatStreamLine } from "@eidolon/chat";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { saidFacts, tellCompanion } from "@/features/companion/chat-facts";
import { asApiError } from "@/lib/api";
import { followLive, sendMessage, sendVoice, stopChat } from "@/lib/chats";
import { toastError } from "@/lib/feedback";
import { chatQuery, chatsQuery } from "./queries";
import { reread } from "./reread";
import {
  awaitReport,
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

/**
 * How long a call's feed, or the wait for her report, waits to ask GET live again, after a 204 or a
 * dropped stream.
 */
const CALL_FEED_RETRY_MS = 2000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ChatTurns {
  readonly live: LiveState;
  /** A line is on its way to the log, or a reply is under way. */
  readonly busy: boolean;
  /** A line, with the files it carries, already kept in the chat. */
  send(text: string, files?: readonly Attachment[]): void;
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

/**
 * `calling`: a call is on in the chat, whose lines GET live carries as they are stored.
 * `awaitingReport`: when the page saw a task of the chat end whose report, a turn with no line of
 * the viewer's, isn't in the log yet, the latest; null for none.
 * `quiet`: a call is up in the tab, or the server's in the chat: none of her voice messages plays
 * on its own, or waits to.
 * `serverActive`: GET chats still sees a turn, upload or call running on this chat.
 * `serverLastSeq`: GET chats' latest seq, used to catch up after a turn finishes off-stream.
 */
export function useChat(
  id: string,
  calling: boolean,
  awaitingReport: number | null,
  quiet: boolean,
  serverActive = false,
  serverLastSeq = 0,
): ChatTurns {
  const queryClient = useQueryClient();
  const [live, dispatch] = useReducer(reduceLive, IDLE);
  const streams = useRef(new Set<AbortController>());
  /** When the last stream that carried a line ended. */
  const carried = useRef(0);
  const sends = useRef(new Sends());
  const [toPlay, setToPlay] = useState<readonly number[]>([]);
  const quietRef = useRef(quiet);

  useEffect(() => {
    quietRef.current = quiet;
    if (!quiet) return;
    pausePlayback();
    setToPlay([]);
  }, [quiet]);

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
      let sendFailed = false;
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
            const held = queryClient.getQueryData(chatQuery(id).queryKey);
            store(line.events);
            for (const fact of saidFacts(id, line.events, held)) tellCompanion(fact);
            const replies = key === null || superseded ? [] : voiceReplies(line.events);
            if (replies.length > 0) {
              const state = { focused: document.hasFocus(), quiet: quietRef.current };
              setToPlay((waiting) => queueReplies(waiting, replies, state));
            }
          } else if (line.type === "started" && reached) [turn, ended] = [line.turn, false];
          else if (line.type === "ended" && line.turn === turn) ended = true;
          if (reached) dispatch(line.type === "events" && key !== null ? { ...line, key } : line);
        }
      } catch (error) {
        broke = !controller.signal.aborted;
        if (key !== null) {
          sendFailed = true;
          if (controller.signal.aborted) {
            toastError(error);
          } else {
            const { code, message } = asApiError(error);
            dispatch({ type: "send-failed", key, error: { code, message } });
          }
        }
      } finally {
        streams.current.delete(controller);
        if (following) dispatch({ type: "unfollow" });
        if (received) carried.current = Date.now();
      }
      if (controller.signal.aborted) {
        // A send or live reply left running on the server needs the sidebar list refreshed.
        if ((key !== null && !sendFailed) || received) {
          void queryClient.invalidateQueries({ queryKey: chatsQuery.queryKey, exact: true });
          void queryClient.invalidateQueries({ queryKey: chatQuery(id).queryKey });
        }
        return;
      }
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

  // Her report starts once its task's final is stored and no reply runs, so live is asked again
  // until it comes; each answer, a 204 included, rereads the log.
  useEffect(() => {
    if (awaitingReport === null || calling) return;
    let on = true;
    void awaitReport(
      {
        open: () => streams.current.size,
        carried: () => carried.current,
        follow: () => follow((signal) => followLive(id, signal), null, false),
        pause: () => pause(CALL_FEED_RETRY_MS),
        now: Date.now,
        on: () => on,
      },
      awaitingReport,
    );
    return () => {
      on = false;
    };
  }, [awaitingReport, calling, id, follow]);

  // Reopening while hearing or turn setup runs can get 204 before GET live starts; retry while active.
  useEffect(() => {
    if (!serverActive || calling || awaitingReport !== null) return;
    let on = true;
    void (async () => {
      while (on) {
        if (streams.current.size === 0) {
          await follow((signal) => followLive(id, signal), null, true);
          if (!on) return;
        }
        await pause(CALL_FEED_RETRY_MS);
      }
    })();
    return () => {
      on = false;
    };
  }, [serverActive, calling, awaitingReport, id, follow]);

  const caughtUp = useRef({ id, seq: 0 });
  const catchUpActive = useRef(id);
  const catchUpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [catchUpRetry, setCatchUpRetry] = useState(0);

  useEffect(() => {
    catchUpActive.current = id;
    return () => {
      catchUpActive.current = "";
      if (catchUpTimer.current !== null) {
        clearTimeout(catchUpTimer.current);
        catchUpTimer.current = null;
      }
    };
  }, [id]);

  useEffect(() => {
    if (catchUpRetry < 0 || streams.current.size > 0) return;
    const cached = queryClient.getQueryData(chatQuery(id).queryKey);
    if (cached === undefined) return;
    const localSeq = cached.events.at(-1)?.seq ?? 0;
    if (serverLastSeq <= localSeq) return;
    const prev = caughtUp.current.id === id ? caughtUp.current.seq : 0;
    if (serverLastSeq <= prev) return;
    caughtUp.current = { id, seq: serverLastSeq };
    const key = chatQuery(id).queryKey;
    const scheduleRetry = () => {
      if (caughtUp.current.id === id && caughtUp.current.seq === serverLastSeq) {
        caughtUp.current = { id, seq: prev };
      }
      if (catchUpActive.current !== id) return;
      if (catchUpTimer.current !== null) clearTimeout(catchUpTimer.current);
      catchUpTimer.current = setTimeout(() => {
        catchUpTimer.current = null;
        setCatchUpRetry((count) => count + 1);
      }, CALL_FEED_RETRY_MS);
    };
    void reread(queryClient, key).then(() => {
      if (queryClient.getQueryState(key)?.status === "error") scheduleRetry();
    }, scheduleRetry);
  }, [id, serverLastSeq, catchUpRetry, queryClient]);

  const send = useCallback(
    (text: string, files: readonly Attachment[] = []) => {
      const key = sends.current.issue();
      const after = queryClient.getQueryData(chatQuery(id).queryKey)?.events.at(-1)?.seq ?? 0;
      dispatch({ type: "sending", key, after, text, files });
      void follow((signal) => sendMessage(id, text, files, signal), key, true);
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
    autoPlay: quiet ? null : (toPlay[0] ?? null),
    autoPlayEnded,
  };
}
