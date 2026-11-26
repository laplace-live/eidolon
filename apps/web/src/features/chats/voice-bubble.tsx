import { useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, PauseIcon, PlayIcon } from "lucide-react";
import { type ReactNode, type SyntheticEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { tellCompanion } from "@/features/companion/chat-facts";
import type { ChatFact } from "@/features/companion/protocol";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { claimPlayback, knownDuration, playsNextAfter, releasePlayback } from "./voice";

/**
 * Ends a bubble's auto-play: `next` when it played through or broke off, so the reply waiting next
 * may play; not when it was paused or couldn't start.
 */
export type AutoPlayEnd = (next: boolean) => void;

type VoiceFact = Extract<ChatFact, { readonly type: "voice" }>;

/** Her voice message, which the desktop companion's mouth follows. */
export type VoiceBubbleFact = Omit<VoiceFact, "type" | "state" | "position">;

/** Tells the desktop companion whether her voice message plays, and where in it `audio` is. */
function tell(
  fact: VoiceBubbleFact | undefined,
  audio: HTMLAudioElement,
  state: VoiceFact["state"],
) {
  if (fact === undefined) return;
  tellCompanion({ type: "voice", ...fact, state, position: audio.currentTime });
}

/** A recording made here, as a URL the bubble can play; null until it is made. */
export function useObjectUrl(blob: Blob): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}

/**
 * A voice message: play and pause, its progress and length, and its transcript folded under it.
 * Starting one pauses whichever was playing.
 */
export function VoiceBubble({
  src,
  durationMs,
  mine,
  speaker,
  transcript,
  autoPlay = false,
  onAutoPlayEnd,
  fact,
  aside,
}: {
  readonly src: string | null;
  /** As stored or recorded; null reads it from the file. */
  readonly durationMs: number | null;
  /** The viewer's own, on the right. */
  readonly mine: boolean;
  /** Whose it is, for a screen reader. */
  readonly speaker: string;
  /** What it says, folded until asked for; null for none to show. */
  readonly transcript: ReactNode | null;
  readonly autoPlay?: boolean;
  readonly onAutoPlayEnd?: AutoPlayEnd;
  /** Her voice message, which the desktop companion's mouth follows; absent for the viewer's own. */
  readonly fact?: VoiceBubbleFact;
  /** Beside her player bubble, above the transcript. */
  readonly aside?: ReactNode;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [measured, setMeasured] = useState<number | null>(null);
  const auto = useRef(false);
  const scanning = useRef(false);
  const facts = useRef(fact);
  const duration = durationMs ?? measured;

  useEffect(() => {
    facts.current = fact;
  });

  useEffect(() => {
    const audio = ref.current;
    if (!autoPlay || audio === null || src === null) return;
    auto.current = true;
    // A file that can't load fails play() after its error event, which already passed it over.
    audio.play().catch(() => {
      if (!auto.current) return;
      auto.current = false;
      onAutoPlayEnd?.(false);
    });
  }, [autoPlay, src, onAutoPlayEnd]);

  useEffect(() => {
    const audio = ref.current;
    return () => {
      if (audio === null) return;
      // The pause below reaches no handler once the bubble is gone.
      if (!audio.paused) tell(facts.current, audio, "ended");
      audio.pause();
      releasePlayback(audio);
    };
  }, []);

  function endAuto(next: boolean | null) {
    if (next === null || !auto.current) return;
    auto.current = false;
    onAutoPlayEnd?.(next);
  }

  /** It paused, played through, or broke off. */
  function onStopped(event: SyntheticEvent<HTMLAudioElement>) {
    const audio = event.currentTarget;
    tell(fact, audio, event.type === "pause" && !audio.ended ? "paused" : "ended");
    setPlaying(false);
    releasePlayback(audio);
    if (event.type === "ended") {
      setPosition(0);
      audio.currentTime = 0;
    }
    endAuto(playsNextAfter(event.type, audio.ended));
    // An error leaves it unpaused, and a press would pause it instead of playing.
    if (event.type === "error") audio.pause();
  }

  function toggle() {
    const audio = ref.current;
    if (audio === null) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    endAuto(false);
    audio.play().catch(() => setPlaying(false));
  }

  function onMetadata(event: SyntheticEvent<HTMLAudioElement>) {
    const audio = event.currentTarget;
    const known = knownDuration(audio.duration);
    if (known !== null) {
      setMeasured(known);
    } else if (audio.duration === Number.POSITIVE_INFINITY && durationMs === null) {
      // Chrome's MediaRecorder writes WebM with no duration, and seeking past the end makes it
      // find one: https://crbug.com/642012
      scanning.current = true;
      audio.currentTime = 1e7;
    }
  }

  function onDurationChange(event: SyntheticEvent<HTMLAudioElement>) {
    const audio = event.currentTarget;
    const known = knownDuration(audio.duration);
    if (known === null) return;
    setMeasured(known);
    if (scanning.current) {
      scanning.current = false;
      audio.currentTime = 0;
    }
  }

  const shown =
    playing || position > 0
      ? formatDuration(position / 1000)
      : duration === null
        ? ""
        : formatDuration(duration / 1000);
  const hasAside = !mine && aside !== undefined && aside !== null && aside !== false;
  return (
    <div
      className={cn(
        "grid max-w-full gap-y-1",
        hasAside ? "grid-cols-[minmax(0,16rem)_auto] gap-x-0.5" : "grid-cols-[minmax(0,16rem)]",
      )}
    >
      <div
        className={cn(
          "flex w-full items-center gap-2 rounded-2xl py-1.5 pr-3 pl-1.5",
          mine ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted",
        )}
      >
        <span className="sr-only">{speaker}: </span>
        <Button
          type="button"
          size="icon-sm"
          variant={mine ? "secondary" : "default"}
          className="rounded-full"
          disabled={src === null}
          aria-label={playing ? t`Pause Voice Message` : t`Play Voice Message`}
          onClick={toggle}
        >
          {playing ? <PauseIcon className="fill-current" /> : <PlayIcon className="fill-current" />}
        </Button>
        <input
          type="range"
          min={0}
          max={duration ?? 0}
          step={100}
          value={Math.min(position, duration ?? 0)}
          disabled={duration === null || src === null}
          aria-label={t`Playback Position`}
          aria-valuetext={
            duration === null
              ? undefined
              : `${formatDuration(position / 1000)} / ${formatDuration(duration / 1000)}`
          }
          onChange={(event) => {
            const at = Number(event.target.value);
            setPosition(at);
            if (ref.current !== null) ref.current.currentTime = at / 1000;
          }}
          className={cn(
            "h-1.5 min-w-0 flex-1 cursor-pointer disabled:cursor-default",
            mine ? "accent-primary-foreground" : "accent-primary",
          )}
        />
        <span aria-hidden className="w-8 shrink-0 text-right text-xs tabular-nums">
          {shown}
        </span>
        {/* biome-ignore lint/a11y/useMediaCaption: the transcript under the bubble is its caption. */}
        <audio
          ref={ref}
          src={src ?? undefined}
          // Metadata only tells a length the message doesn't already have.
          preload={durationMs === null ? "metadata" : "none"}
          onLoadedMetadata={onMetadata}
          onDurationChange={onDurationChange}
          onTimeUpdate={(event) => {
            if (!scanning.current) setPosition(event.currentTarget.currentTime * 1000);
          }}
          onPlay={(event) => {
            claimPlayback(event.currentTarget);
            setPlaying(true);
            tell(fact, event.currentTarget, "playing");
          }}
          onSeeked={(event) => {
            if (!event.currentTarget.paused) tell(fact, event.currentTarget, "playing");
          }}
          onPause={onStopped}
          onEnded={onStopped}
          onError={onStopped}
        />
      </div>
      {hasAside && <div className="flex self-end">{aside}</div>}
      {transcript !== null && <Transcript mine={mine}>{transcript}</Transcript>}
    </div>
  );
}

function Transcript({ mine, children }: { readonly mine: boolean; readonly children: ReactNode }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "col-start-1 flex w-full min-w-0 flex-col gap-1",
        mine ? "items-end" : "items-start",
      )}
    >
      <CollapsibleTrigger asChild>
        <Button variant="link" size="xs" className="h-auto p-0 text-muted-foreground">
          {open ? t`Hide Transcript` : t`Show Transcript`}
          <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="w-full whitespace-pre-line break-words rounded-xl border px-3 py-2 text-sm">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
