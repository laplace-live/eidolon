import { useQuery } from "@tanstack/react-query";
import { BrainIcon, KeyRoundIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useRevalidator } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorKey, type MemoryStatus, type Status } from "@/lib/api";
import { type Translate, useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { CallControls, MicPill } from "./call-controls";
import { CallNotices } from "./call-notices";
import { formatDuration } from "./format";
import { PersonaAvatar, type PersonaFace } from "./persona-avatar";
import type { CallPhase } from "./phase";
import { TranscriptView } from "./transcript-view";
import { useCall } from "./use-call";

/** Now, once a second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

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
          <button type="button" className={cn(!on && "text-muted-foreground")}>
            <BrainIcon data-icon="inline-start" />
            {t(on ? "call.memory.on" : "call.memory.off")}
          </button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

function CallRoom({ status, onEnded }: { readonly status: Status; readonly onEnded: () => void }) {
  const t = useT();
  const call = useCall();
  const { revalidate } = useRevalidator();
  const { phase } = call;
  const { id, name, shortName } = status.persona;
  const persona = useMemo<PersonaFace>(() => ({ id, name, shortName }), [id, name, shortName]);
  const short = shortName.trim() || name;
  const now = useNow(phase.name === "live" && phase.answeredAt !== null);

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
  const placeholder =
    phase.name === "idle" || phase.name === "ended"
      ? t("call.transcript.empty", { name: short })
      : t("call.transcript.waiting", { name: short });

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col">
      <h1 className="sr-only">{t("call.title")}</h1>
      <section className="flex flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <header className="flex items-center gap-3 border-b px-4 py-3">
          <PersonaAvatar persona={persona} size="lg" speaking={call.botSpeaking} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-heading text-base font-semibold">{name}</h2>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {waiting && <Spinner className="size-3" />}
              <span className="truncate">{stateLine(phase, now, short, t)}</span>
            </p>
          </div>
          <MemoryChip memory={status.memory} name={short} />
        </header>
        <CallNotices call={call} status={status} name={short} />
        <div className="relative">
          <TranscriptView
            transcript={call.transcript}
            wait={call.wait}
            name={short}
            placeholder={placeholder}
          />
          <MicPill call={call} />
        </div>
        <footer className="border-t">
          <CallControls call={call} name={short} />
        </footer>
      </section>
      {/* biome-ignore lint/a11y/useMediaCaption: a live MediaStream takes no track; the transcript is its caption. */}
      <audio ref={call.audioRef} autoPlay hidden />
    </div>
  );
}

/** What has to be fixed before a call can start. */
function Blocker({
  media,
  title,
  body,
  to,
  action,
}: {
  readonly media: ReactNode;
  readonly title: string;
  readonly body: string;
  readonly to: string;
  readonly action: string;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      {media}
      <h1 className="font-heading text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      <Button asChild>
        <Link to={to}>{action}</Link>
      </Button>
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
        media={
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <KeyRoundIcon className="size-6 text-muted-foreground" />
          </div>
        }
        title={t("call.keys.missing.title")}
        body={t("call.keys.missing.body")}
        to="/setup"
        action={t("call.keys.add")}
      />
    );
  }
  if (persona.voice.id === null) {
    return (
      <Blocker
        media={<PersonaAvatar persona={persona} size="lg" />}
        title={t("call.voice.missing.title", { name: short })}
        body={t("call.voice.missing.body")}
        to={`/personas/${encodeURIComponent(persona.id)}/voice`}
        action={t("call.voice.pick")}
      />
    );
  }
  // A persona switch starts a fresh room: the server refuses one during a call.
  return <CallRoom key={persona.id} status={status} onEnded={onEnded} />;
}
