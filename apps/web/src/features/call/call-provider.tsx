// The tab's one call, which the app's shell holds so it outlives the page that placed it: the
// engine and its audio, whom the call is with and how it shows, and her stages and their signals.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRevalidator } from "react-router";
import { chatQuery } from "@/features/chats/queries";
import { callOn } from "@/features/chats/stream";
import { pausePlayback } from "@/features/chats/voice";
import { CompanionFeed } from "@/features/companion/feed";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { Status } from "@/lib/api";
import { subscribeWindowShows, windowShows } from "@/lib/desktop";
import { statusQuery } from "@/lib/query";
import {
  type CallPresence,
  CallPresenceContext,
  type ShellCall,
  ShellCallContext,
} from "./call-context";
import { loadCastModel } from "./cast";
import { CallSignals } from "./signals";
import { CallStages } from "./stages";
import { type CallLayout, type CallTarget, isUp, offerData, opensVideo, outlived } from "./target";
import { useCall } from "./use-call";

const activeOf = (status: Status) => status.persona.id;

export function CallProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const queryClient = useQueryClient();
  const { revalidate } = useRevalidator();
  const [signals] = useState(() => new CallSignals());
  const [stages] = useState(() => new CallStages(signals));
  const engine = useCall(signals);
  const { audioRef, start: dial, ...handle } = engine;
  const { phase } = engine;
  const [target, setTarget] = useState<CallTarget | null>(null);
  const [serverCall, setServerCall] = useState<string | null>(null);
  const [layout, setLayout] = useState<CallLayout>("screen");
  const [views, setViews] = useState(0);
  // Set as a call is placed and cleared once it is over, so two clicks in one frame place one call.
  const placing = useRef(false);
  const up = isUp(phase);
  const reduced = useReducedMotion();
  const blank = useSyncExternalStore(stages.subscribe, () => stages.blank);
  // A desktop app's window hidden while it feeds the desktop companion keeps its page running, so its
  // stages would draw for no one; the call, its signals and the feed go on.
  const windowShown = useSyncExternalStore(subscribeWindowShows, windowShows);
  useEffect(() => stages.hold(!windowShown), [stages, windowShown]);
  const video = target !== null && opensVideo(target) && !blank;
  const shown = views > 0;
  const { data: active = null } = useQuery({ ...statusQuery, select: activeOf });

  const show = useCallback(() => {
    setViews((count) => count + 1);
    return () => setViews((count) => count - 1);
  }, []);

  const start = useCallback(
    (next: CallTarget) => {
      if (placing.current) return;
      placing.current = true;
      setTarget(next);
      setServerCall(null);
      setLayout("screen");
      // Before the steps below: whatever they do, the call is placed, and placing clears as it ends.
      dial(offerData(next));
      pausePlayback();
      // The AudioContext her mouth reads from runs only if it is made or resumed in the click.
      signals.wake();
      signals.begin();
      stages.dispose();
      if (opensVideo(next)) {
        stages.load(next, {
          load: (member, canvas, signal) => loadCastModel(queryClient, member, canvas, signal),
          reducedMotion: reduced,
        });
      }
    },
    [dial, signals, stages, queryClient, reduced],
  );

  const close = useCallback(() => {
    if (up) return;
    setTarget(null);
    setServerCall(null);
  }, [up]);

  useEffect(() => {
    if (up) return;
    placing.current = false;
    stages.dispose();
    signals.end();
  }, [up, stages, signals]);

  // While this tab's call is up, the chat holds no other: the call a read made then says it holds
  // is this one. Neither the offer's answer nor the page's clock names it, and the cached log may
  // still name a call a killed server never ended. A read already in flight, which fetchQuery would
  // hand back, may have started before the call was live, so it is cancelled first.
  const live = phase.name === "live";
  const chatId = target?.kind === "chat" ? target.chatId : null;
  useEffect(() => {
    if (!live || chatId === null) return;
    let current = true;
    const query = chatQuery(chatId);
    void (async () => {
      await queryClient.cancelQueries({ queryKey: query.queryKey, exact: true });
      const read = await queryClient.fetchQuery({ ...query, staleTime: 0 }).catch(() => null);
      const held = read === null ? null : callOn(read);
      if (current && held !== null) setServerCall((placed) => placed ?? held.id);
    })();
    return () => {
      current = false;
    };
  }, [live, chatId, queryClient]);

  // Status then says whether the bot recorded a failure, and whether Qdrant still answers.
  const ended = phase.name === "ended";
  useEffect(() => {
    if (ended) void queryClient.invalidateQueries({ queryKey: statusQuery.queryKey, exact: true });
  }, [ended, queryClient]);

  // A refused session shows the locked screen.
  const signedOut = ended && phase.end.kind === "connect" && phase.end.status === 401;
  useEffect(() => {
    if (signedOut) void revalidate();
  }, [signedOut, revalidate]);

  // A /call call over before a persona switch leaves the bar as it leaves /call.
  useEffect(() => {
    if (!outlived({ target, phase }, active)) return;
    setTarget(null);
    setServerCall(null);
  }, [target, phase, active]);

  useEffect(
    () => () => {
      stages.dispose();
      signals.close();
    },
    [stages, signals],
  );

  const presence = useMemo<CallPresence>(
    () => ({
      target,
      phase,
      up,
      serverCall,
      layout,
      video,
      shown,
      start,
      close,
      setLayout,
      show,
      signals,
      stages,
    }),
    [target, phase, up, serverCall, layout, video, shown, start, close, show, signals, stages],
  );
  const full: ShellCall = { ...handle, ...presence };

  return (
    <CallPresenceContext.Provider value={presence}>
      <ShellCallContext.Provider value={full}>
        {children}
        <CompanionFeed />
        {/* biome-ignore lint/a11y/useMediaCaption: a live MediaStream takes no track; the call's captions and transcript are its caption. */}
        <audio ref={audioRef} autoPlay hidden data-call />
      </ShellCallContext.Provider>
    </CallPresenceContext.Provider>
  );
}
