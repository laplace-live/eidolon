import { useQuery } from "@tanstack/react-query";
import { AudioLinesIcon, BrainIcon, KeyRoundIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorKey, type MemoryStatus, type Status } from "@/lib/api";
import { type Translate, useT } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { CallControls, MicPill } from "./call-controls";
import { CallNotices } from "./call-notices";
import { formatDuration } from "./format";
import type { CallPhase } from "./phase";
import { TranscriptView } from "./transcript-view";
import { useCall } from "./use-call";

type Persona = Status["persona"];

function stateLine(phase: CallPhase, now: number, name: string, t: Translate): string {
  switch (phase.name) {
    case "idle":
      return t("call.state.idle");
    case "starting":
      return t("call.state.starting");
    case "connecting":
      return t("call.state.connecting");
    case "live":
      return phase.answeredAt === null
        ? t("call.state.ringing", { name })
        : t("call.state.live", { duration: formatDuration(now - phase.answeredAt) });
    case "ending":
      return t("call.state.ending");
    case "ended":
      return phase.answeredAt === null
        ? t("call.state.ended")
        : t("call.state.endedAfter", {
            duration: formatDuration(phase.endedAt - phase.answeredAt),
          });
  }
}

/** The call's state; only this line renders each second while the call runs. */
function CallState({ phase, name }: { readonly phase: CallPhase; readonly name: string }) {
  const t = useT();
  const now = useNow(phase.name === "live" && phase.answeredAt !== null);
  return stateLine(phase, now, name, t);
}

function MemoryChip({ memory, name }: { readonly memory: MemoryStatus; readonly name: string }) {
  const t = useT();
  const on = memory.configured && memory.reachable !== false;
  const hint = !memory.configured
    ? t("call.memory.offHint", { name })
    : memory.reachable === false
      ? t("call.memory.downHint", { name })
      : t("call.memory.onHint", { name });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge asChild variant={on ? "secondary" : "outline"}>
          <button type="button" className={cn("shrink-0", !on && "text-muted-foreground")}>
            <BrainIcon data-icon="inline-start" />
            {t(on ? "call.memory.on" : "call.memory.off")}
          </button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** Her avatar, ringed while she speaks. */
function Face({
  persona,
  size,
  speaking = false,
}: {
  readonly persona: Persona;
  readonly size: "md" | "xl";
  readonly speaking?: boolean;
}) {
  return (
    <PersonaAvatar
      persona={persona}
      size={size}
      className={cn(
        "transition-shadow",
        speaking && "ring-2 ring-success ring-offset-2 ring-offset-card",
      )}
    />
  );
}

/**
 * The call's one panel, as tall as the window leaves it: who she is and how the call stands, what
 * is said, then the controls.
 */
function Frame({
  persona,
  speaking,
  state,
  aside,
  footer,
  children,
}: {
  readonly persona: Persona;
  readonly speaking: boolean;
  readonly state: ReactNode;
  readonly aside?: ReactNode;
  readonly footer: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex h-[calc(100svh-var(--app-header-height)-5rem)] max-h-[56rem] min-h-[30rem] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground">
      <header className="flex items-center gap-3 border-b px-4 py-3 sm:px-6 sm:py-4">
        <Face persona={persona} size="md" speaking={speaking} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-base tracking-tight">{persona.name}</h2>
          <p className="flex items-center gap-1.5 text-muted-foreground text-sm">{state}</p>
        </div>
        {aside}
      </header>
      {children}
      <footer className="border-t bg-muted/50">{footer}</footer>
    </section>
  );
}

/** What fills the panel before anything is said: her, and a line on what comes next. */
function Intro({
  media,
  title,
  body,
}: {
  readonly media: ReactNode;
  readonly title: ReactNode;
  readonly body: string;
}) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-5 text-center">
      {media}
      <div className="flex flex-col gap-1.5">
        {title}
        <p className="text-balance text-muted-foreground text-sm">{body}</p>
      </div>
    </div>
  );
}

function CallRoom({ status, onEnded }: { readonly status: Status; readonly onEnded: () => void }) {
  const t = useT();
  const call = useCall();
  const { revalidate } = useRevalidator();
  const { phase } = call;
  const { persona } = status;
  const short = persona.shortName.trim() || persona.name;

  // Status then says whether the bot recorded a failure, and whether Qdrant still answers.
  const ended = phase.name === "ended";
  useEffect(() => {
    if (ended) onEnded();
  }, [ended, onEnded]);
  // A refused session shows the locked screen.
  const signedOut = ended && phase.end.kind === "connect" && phase.end.status === 401;
  useEffect(() => {
    if (signedOut) void revalidate();
  }, [signedOut, revalidate]);

  const waiting =
    phase.name === "starting" ||
    phase.name === "connecting" ||
    phase.name === "ending" ||
    (phase.name === "live" && phase.answeredAt === null);
  const answered = phase.name === "live" && phase.answeredAt !== null;
  const placeholder =
    phase.name === "idle" || phase.name === "ended"
      ? t("call.transcript.empty", { name: short })
      : t("call.transcript.waiting", { name: short });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      <h1 className="sr-only">{t("call.title")}</h1>
      <Frame
        persona={persona}
        speaking={call.botSpeaking}
        state={
          <>
            {waiting && <Spinner className="size-3.5 shrink-0" />}
            {answered && <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />}
            <span className="truncate">
              <CallState phase={phase} name={short} />
            </span>
          </>
        }
        aside={<MemoryChip memory={status.memory} name={short} />}
        footer={<CallControls call={call} name={short} />}
      >
        <CallNotices call={call} status={status} name={short} />
        <div className="relative min-h-0 flex-1">
          <TranscriptView
            transcript={call.transcript}
            wait={call.wait}
            name={short}
            intro={
              <Intro
                media={<Face persona={persona} size="xl" speaking={call.botSpeaking} />}
                title={<p className="font-semibold text-xl tracking-tight">{persona.name}</p>}
                body={placeholder}
              />
            }
          />
          <MicPill call={call} />
        </div>
      </Frame>
      {/* biome-ignore lint/a11y/useMediaCaption: a live MediaStream takes no track; the transcript is its caption. */}
      <audio ref={call.audioRef} autoPlay hidden />
    </div>
  );
}

/** What has to be fixed before a call can start, in the panel the call would use. */
function Blocker({
  persona,
  media,
  title,
  body,
  to,
  icon,
  action,
}: {
  readonly persona: Persona;
  readonly media: ReactNode;
  readonly title: string;
  readonly body: string;
  readonly to: string;
  readonly icon: ReactNode;
  readonly action: string;
}) {
  const t = useT();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      <h1 className="sr-only">{t("call.title")}</h1>
      <Frame
        persona={persona}
        speaking={false}
        state={<span className="truncate">{t("call.state.idle")}</span>}
        footer={
          <div className="flex justify-center px-4 py-4 sm:px-6">
            <Button size="lg" asChild>
              <Link to={to}>
                {icon}
                {action}
              </Link>
            </Button>
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <Intro
            media={media}
            title={<h2 className="font-semibold text-xl tracking-tight">{title}</h2>}
            body={body}
          />
        </div>
      </Frame>
    </div>
  );
}

export function CallPage() {
  const t = useT();
  const { data: status, error, refetch } = useQuery(statusQuery);
  const onEnded = useCallback(() => void refetch(), [refetch]);

  if (status === undefined) {
    if (error === null) {
      return (
        <div className="flex justify-center py-16">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      );
    }
    return (
      <Alert variant="destructive" className="mx-auto max-w-lg">
        <AlertTitle>{t("common.error.title")}</AlertTitle>
        <AlertDescription>{t(errorKey(error))}</AlertDescription>
      </Alert>
    );
  }

  const { persona } = status;
  const short = persona.shortName.trim() || persona.name;
  if (Object.values(status.keys).includes(false)) {
    return (
      <Blocker
        persona={persona}
        media={
          <div className="flex size-24 items-center justify-center rounded-full bg-muted">
            <KeyRoundIcon className="size-9 text-muted-foreground" />
          </div>
        }
        title={t("call.keys.missing.title")}
        body={t("call.keys.missing.body")}
        to="/setup"
        icon={<KeyRoundIcon data-icon="inline-start" />}
        action={t("call.keys.add")}
      />
    );
  }
  if (persona.voice.id === null) {
    return (
      <Blocker
        persona={persona}
        media={<Face persona={persona} size="xl" />}
        title={t("call.voice.missing.title", { name: short })}
        body={t("call.voice.missing.body")}
        to={studioPath(persona.id, "voice")}
        icon={<AudioLinesIcon data-icon="inline-start" />}
        action={t("call.voice.pick")}
      />
    );
  }
  // A persona switch starts a fresh room: the server refuses one during a call.
  return <CallRoom key={persona.id} status={status} onEnded={onEnded} />;
}
