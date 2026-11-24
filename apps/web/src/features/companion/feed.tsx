import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { personasQuery } from "@/components/settings-form/queries";
import { useShellCall } from "@/features/call/call-context";
import { soloTarget } from "@/features/call/target";
import { characterModelsQuery } from "@/lib/character-models";
import {
  type CompanionCallPick,
  desktop,
  type EidolonDesktop,
  onCompanionPort,
  subscribeCompanionPick,
} from "@/lib/desktop";
import { statusQuery } from "@/lib/query";
import { onChatFact } from "./chat-facts";
import { FeedLink, feedState, MOUTH_SEND_MS, mouthLevel } from "./feed-link";
import { appearanceStamp } from "./protocol";

/** A desktop app's bridge with the desktop companion's feed, which older apps lack. */
type FeedBridge = EidolonDesktop &
  Required<Pick<EidolonDesktop, "linkCompanion" | "feedingCompanion">>;

function feeds(app: EidolonDesktop | null): app is FeedBridge {
  return app?.linkCompanion !== undefined && app.feedingCompanion !== undefined;
}

/**
 * The main window's side of the desktop companion: her call and her chat, over the port main pairs.
 * It renders nothing, and only in a desktop app that offers her.
 */
export const CompanionFeed = memo(function CompanionFeed(): ReactNode {
  const app = desktop();
  return feeds(app) ? <Feed app={app} /> : null;
});

/**
 * Rendered again at each of the call's events, it draws nothing, and its effects run only as what
 * they send changes.
 */
function Feed({ app }: { readonly app: FeedBridge }): ReactNode {
  const { target, phase, up, micOn, start, signals, setMic, hangUp } = useShellCall();
  const { data: status } = useQuery(statusQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { persona, call, key, feeding } = feedState(status, { target, phase, up, micOn });
  const current = { status, callable: call.callable, start, navigate, hangUp, setMic };
  const latest = useRef(current);
  // The one thing her page asks of this window: her models and her summary, read again.
  const [link] = useState(
    () =>
      new FeedLink(({ persona: changed }) => {
        void queryClient.invalidateQueries({
          queryKey: characterModelsQuery(changed).queryKey,
          exact: true,
        });
        void queryClient.invalidateQueries({ queryKey: personasQuery.queryKey, exact: true });
        void queryClient.invalidateQueries({ queryKey: statusQuery.queryKey });
      }),
  );

  useEffect(() => {
    latest.current = current;
  });

  useEffect(() => {
    // Main hands over her menu's call picks, which only the owner's click on it makes.
    const act = (pick: CompanionCallPick) => {
      const now = latest.current;
      switch (pick) {
        case "call":
          if (now.callable && now.status !== undefined) now.start(soloTarget(now.status.persona));
          now.navigate("/call");
          return;
        case "hang-up":
          now.hangUp();
          return;
        case "mute":
        case "unmute":
          now.setMic(pick === "unmute");
          return;
      }
    };
    const stop = onCompanionPort((port) => link.connect(port));
    app.linkCompanion();
    const unpick = subscribeCompanionPick(act);
    return () => {
      stop();
      unpick();
      link.disconnect();
      app.feedingCompanion(false);
    };
  }, [app, link]);

  const stamp = status === undefined ? null : appearanceStamp(status.persona.appearance.model);
  useEffect(() => {
    if (persona !== null && stamp !== null) link.persona(persona, stamp);
  }, [link, persona, stamp]);

  const { up: callUp, live, hers, micOn: callMicOn, callable } = call;
  useEffect(() => {
    link.call({ up: callUp, live, hers, micOn: callMicOn, callable });
  }, [link, callUp, live, hers, callMicOn, callable]);

  useEffect(() => {
    app.feedingCompanion(feeding);
  }, [app, feeding]);

  useEffect(() => {
    if (!feeding) return;
    const tell = () => link.direction(signals.direction(key));
    const unsubscribe = signals.subscribe(tell);
    tell();
    // A timer, not animation frames: it draws nothing, and a hidden window may get no frames.
    let read = performance.now();
    const timer = setInterval(() => {
      if (!link.linked) return;
      const now = performance.now();
      const level = signals.feedMouth?.read((now - read) / 1000) ?? 0;
      read = now;
      link.mouth(mouthLevel(level, key, (speaker) => signals.direction(speaker).speaking));
    }, MOUTH_SEND_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
      link.mouth(0);
    };
  }, [feeding, signals, key, link]);

  useEffect(() => onChatFact((fact) => link.chat(fact)), [link]);

  return null;
}
