// The tab's call as a video call: her model, or a tile per persona, under the call's notices, her
// newest photo, the caption and the controls. A chat shows it over its column, /call below its
// header.
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  CaptionsIcon,
  CaptionsOffIcon,
  HourglassIcon,
  KeyboardIcon,
  Minimize2Icon,
  ScrollTextIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Thinking } from "@/components/conversation";
import { OpenPicture } from "@/components/picture-viewer";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { shortNameOf } from "@/features/chats/persona";
import type { Status } from "@/lib/api";
import { listOf } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { AvatarView } from "./avatar-view";
import { useShellCall, useShowsCall } from "./call-context";
import { HangUpButton, MessageInput, MicPill, MicToggle } from "./call-controls";
import { CallNotices } from "./call-notices";
import { CallStatus } from "./call-state";
import { CallTiles } from "./call-tiles";
import { type Caption, captionOf, latestSelfie } from "./captions";
import { hostOf, isUp } from "./target";

/** Whether captions were turned off, in this browser. */
const CAPTIONS_KEY = "eidolon.call.captions";

function storedCaptions(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_KEY) !== "off";
  } catch {
    return true;
  }
}

function storeCaptions(on: boolean): void {
  try {
    if (on) localStorage.removeItem(CAPTIONS_KEY);
    else localStorage.setItem(CAPTIONS_KEY, "off");
  } catch {
    // Not kept; it still applies to this call.
  }
}

/** One of the screen's controls, named in its tooltip. */
function ScreenControl({
  label,
  pressed,
  onClick,
  children,
}: {
  readonly label: string;
  /** A toggle's state; a plain button leaves it out. */
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={pressed ? "secondary" : "outline"}
          size="icon-lg"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The last thing said. Not a live region: the call is heard, and /call's transcript announces
 * its lines.
 */
function CaptionLine({ caption, group }: { readonly caption: Caption; readonly group: boolean }) {
  const { t } = useLingui();
  return (
    <p
      data-captions
      data-live={caption.live}
      className={cn(
        "max-w-full shrink-0 rounded-2xl bg-background/80 px-4 py-2 text-center text-base backdrop-blur-sm max-sm:line-clamp-3 sm:max-w-2xl sm:text-lg motion-safe:transition-colors",
        !caption.live && "text-muted-foreground",
      )}
    >
      {caption.kind === "her" ? (
        <>
          {group && caption.speaker !== null && (
            <span data-caption-speaker className="mr-1.5 font-medium">
              {caption.speaker.name}
            </span>
          )}
          <span data-caption-text>{caption.text}</span>
        </>
      ) : (
        <>
          <span className="mr-1.5 font-medium">
            {t({ message: "You", context: "call transcript speaker" })}
          </span>
          <span data-caption-text>
            {caption.said}
            <span className="italic opacity-70">{caption.hearing}</span>
          </span>
        </>
      )}
    </p>
  );
}

/** Her newest photo in the screen's corner, gone if it no longer loads. */
function SelfieThumb({ src, alt }: { readonly src: string; readonly alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <OpenPicture
      src={src}
      alt={alt}
      className="absolute top-3 right-3 block size-16 overflow-hidden rounded-lg shadow-lg ring-1 ring-border"
    >
      <img
        src={src}
        alt={alt}
        decoding="async"
        onError={() => setFailed(true)}
        className="size-full object-cover"
      />
    </OpenPicture>
  );
}

export function VideoCall({
  status,
  className,
  titled,
  typing = false,
  transcript,
  waiting,
  onShrink,
}: {
  /** For the call's notices; they wait for it. */
  readonly status: Status | undefined;
  /** Where it sits: absolute over a chat's column, or the rest of /call's frame. */
  readonly className?: string;
  /** Her name and the timer on top; /call's header shows them already. */
  readonly titled: boolean;
  /** /call's Type a Message, which sends a line on the call. */
  readonly typing?: boolean;
  /** /call's transcript, kept mounted in a panel Transcript opens. */
  readonly transcript?: ReactNode;
  /** The chat's waiting bar, so its answers stay in reach over the column. */
  readonly waiting?: ReactNode;
  /** Docks the call: a chat's Shrink. */
  readonly onShrink?: (() => void) | null;
}): ReactNode {
  const { t } = useLingui();
  const call = useShellCall();
  useShowsCall();
  const root = useRef<HTMLElement>(null);
  const [captions, setCaptions] = useState(storedCaptions);
  const [typeOpen, setTypeOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const { target, phase, transcript: said, wait, botSpeaking } = call;
  const placed = target !== null;

  // The keyboard lands in the call after Call, Expand or Return to Call.
  useEffect(() => {
    if (placed) root.current?.focus({ preventScroll: true });
  }, [placed]);

  if (target === null) return null;
  const host = hostOf(target);
  const group = target.kind === "chat" && target.group;
  const name = group ? listOf(target.cast.map(shortNameOf)) : shortNameOf(host);
  const { speaker } = said;
  const voice =
    group && speaker !== null
      ? target.cast.find((member) => member.id === speaker.persona)
      : undefined;
  const heading = !group
    ? host.name
    : botSpeaking && voice !== undefined
      ? t`${ph({ name: shortNameOf(voice) })} is speaking`
      : t`Everyone`;
  const panelOpen = transcript !== undefined && transcriptOpen;
  const caption = captions && !panelOpen ? captionOf(said, botSpeaking) : null;
  const unheard = group && phase.name === "live" && said.entries.length === 0;
  const selfie = isUp(phase) ? latestSelfie(said) : null;
  const photo = selfie?.paths.at(-1);
  const whose = target.cast.find((member) => member.id === selfie?.persona);
  const photoAlt = t`A selfie from ${ph({ name: whose === undefined ? name : shortNameOf(whose) })}`;

  return (
    <section
      ref={root}
      aria-label={t`Call with ${name}`}
      data-call-screen
      tabIndex={-1}
      className={cn(
        "flex min-h-0 overflow-hidden bg-background outline-none max-md:flex-col",
        className,
      )}
    >
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/40">
        {group ? (
          <CallTiles cast={target.cast} />
        ) : (
          <AvatarView member={host} face="xl" className="absolute inset-0" />
        )}
        {titled && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col items-center gap-0.5 bg-linear-to-b from-background/80 to-transparent px-4 pt-3 pb-8">
            <p className="max-w-full truncate font-semibold">{heading}</p>
            <p className="flex max-w-full items-center gap-1.5 text-muted-foreground text-xs">
              <CallStatus phase={phase} name={name} />
            </p>
          </div>
        )}
        {photo !== undefined && <SelfieThumb key={photo} src={photo} alt={photoAlt} />}
        {status !== undefined && (
          <CallNotices
            call={call}
            status={status}
            name={name}
            persona={host.id}
            className={cn(
              "absolute z-10 border-b-0 bg-transparent",
              titled ? "top-16" : "top-0",
              // Beside her photo, which keeps its clicks.
              photo === undefined ? "inset-x-0" : "right-20 left-0",
            )}
          />
        )}
        {/* At most 70% of the stage, so her name, the timer and the notices keep their place; from
            the bottom up, so the controls stay in view whatever it holds. */}
        <div className="absolute inset-x-0 bottom-0 flex max-h-[70%] flex-col items-center justify-end gap-3 px-4 pb-4">
          <MicPill call={call} className="bottom-full mb-2" />
          {unheard ? (
            <p className="max-w-full shrink-0 text-balance rounded-2xl bg-background/80 px-4 py-2 text-center text-muted-foreground text-sm backdrop-blur-sm">
              {t`Everyone can hear you. Say something to start.`}
            </p>
          ) : (
            caption !== null && <CaptionLine caption={caption} group={group} />
          )}
          {!panelOpen && wait.thinking && !wait.stuck && (
            <div className="shrink-0">
              {/* One persona's name: a group call's lists everyone. */}
              <Thinking label={group ? t`Waiting for a reply…` : t`${name} is thinking…`} />
            </div>
          )}
          {!panelOpen && wait.stuck && (
            <p
              role="status"
              className="flex max-w-full shrink-0 items-center justify-center gap-1.5 rounded-full bg-background/80 px-3 py-1 text-center text-muted-foreground text-xs"
            >
              <HourglassIcon className="size-3.5 shrink-0" />
              {t`Still waiting for ${name}. If nothing comes, say it again.`}
            </p>
          )}
          {waiting !== undefined && (
            // Opaque, so its question reads clearly over her, and the one item that shrinks: a tall
            // one scrolls while the controls stay in view. Gone while it renders nothing.
            <div className="min-h-0 w-full max-w-3xl overflow-y-auto rounded-lg bg-background shadow-lg empty:hidden">
              {waiting}
            </div>
          )}
          {typing && typeOpen && (
            <div className="w-full max-w-md shrink-0 rounded-full bg-card/90 p-1.5 shadow-lg">
              <MessageInput
                disabled={phase.name !== "live"}
                name={name}
                onSend={call.sendText}
                autoFocus
              />
            </div>
          )}
          {/* Each button is named, and the screen's label names the call: no group role. */}
          <div className="flex shrink-0 items-center gap-2 rounded-full border bg-card/90 p-1.5 shadow-lg backdrop-blur">
            <MicToggle call={call} />
            {typing && (
              <ScreenControl
                label={t`Type a Message`}
                pressed={typeOpen}
                onClick={() => setTypeOpen((open) => !open)}
              >
                <KeyboardIcon />
              </ScreenControl>
            )}
            <ScreenControl
              label={t`Captions`}
              pressed={captions}
              onClick={() => {
                storeCaptions(!captions);
                setCaptions(!captions);
              }}
            >
              {captions ? <CaptionsIcon /> : <CaptionsOffIcon />}
            </ScreenControl>
            {transcript !== undefined && (
              <ScreenControl
                label={t`Transcript`}
                pressed={transcriptOpen}
                onClick={() => setTranscriptOpen((open) => !open)}
              >
                <ScrollTextIcon />
              </ScreenControl>
            )}
            {onShrink && (
              <ScreenControl label={t`Shrink`} onClick={onShrink}>
                <Minimize2Icon />
              </ScreenControl>
            )}
            <HangUpButton call={call} />
          </div>
        </div>
      </div>
      {transcript !== undefined && (
        // Always mounted, so the transcript keeps its lines, its scroll and its log in the page.
        // Beside the stage from md; below it on a phone, under the controls.
        <div
          data-call-transcript
          hidden={!transcriptOpen}
          className="relative min-h-0 bg-background max-md:h-[55%] max-md:shrink-0 max-md:border-t md:w-80 md:shrink-0 md:border-l lg:w-96"
        >
          {transcript}
        </div>
      )}
    </section>
  );
}
