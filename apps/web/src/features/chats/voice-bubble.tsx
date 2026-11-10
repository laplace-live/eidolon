import { useLingui } from "@lingui/react/macro";
import { ChevronDownIcon, PauseIcon, PlayIcon } from "lucide-react";
import { type ReactNode, type SyntheticEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { claimPlayback, knownDuration, releasePlayback } from "./voice";

/** Ends a bubble's auto-play: it played through, or was paused, or couldn't start. */
export type AutoPlayEnd = (finished: boolean) => void;

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
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [measured, setMeasured] = useState<number | null>(null);
  const auto = useRef(false);
  const scanning = useRef(false);
  const duration = durationMs ?? measured;

  useEffect(() => {
    const audio = ref.current;
    if (!autoPlay || audio === null || src === null) return;
    auto.current = true;
    audio.play().catch(() => {
      auto.current = false;
      onAutoPlayEnd?.(false);
    });
  }, [autoPlay, src, onAutoPlayEnd]);

  useEffect(() => {
    const audio = ref.current;
    return () => {
      if (audio === null) return;
      audio.pause();
      releasePlayback(audio);
    };
  }, []);

  function endAuto(finished: boolean) {
    if (!auto.current) return;
    auto.current = false;
    onAutoPlayEnd?.(finished);
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
  return (
    <div className={cn("flex w-64 max-w-full flex-col gap-1", mine ? "items-end" : "items-start")}>
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
          }}
          onPause={(event) => {
            setPlaying(false);
            releasePlayback(event.currentTarget);
            // Playing through pauses too, just before it ends.
            if (!event.currentTarget.ended) endAuto(false);
          }}
          onEnded={(event) => {
            setPlaying(false);
            setPosition(0);
            event.currentTarget.currentTime = 0;
            endAuto(true);
          }}
        />
      </div>
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
      className={cn("flex w-full flex-col gap-1", mine ? "items-end" : "items-start")}
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
