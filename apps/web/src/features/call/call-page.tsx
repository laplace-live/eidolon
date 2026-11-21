import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { AudioLinesIcon, BrainIcon, KeyRoundIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MemoryStatus, Status } from "@/lib/api";
import { listOf } from "@/lib/labels";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { CallControls, MicPill } from "./call-controls";
import { CallNotices } from "./call-notices";
import { CallStatus, Face } from "./call-state";
import { TranscriptView } from "./transcript-view";
import { useCall } from "./use-call";

type Persona = Status["persona"];

function MemoryChip({ memory, name }: { readonly memory: MemoryStatus; readonly name: string }) {
  const { t } = useLingui();
  const on = memory.configured && memory.reachable !== false;
  const hint = !memory.configured
    ? t`Memory needs Qdrant. Set it up in Settings so ${name} remembers your calls.`
    : memory.reachable === false
      ? t`Qdrant isn't answering, so ${name} won't remember this call.`
      : t`${name} remembers your conversations between calls.`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge asChild variant={on ? "secondary" : "outline"}>
          <button type="button" className={cn("shrink-0", !on && "text-muted-foreground")}>
            <BrainIcon data-icon="inline-start" />
            {on ? t`Memory on` : t`Memory off`}
          </button>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** The call, filling the frame: who she is and how it stands, what is said, then the controls. */
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
    <section className="flex min-h-0 flex-1 flex-col">
      <header data-window-drag className="flex items-center gap-3 border-b px-4 py-3 sm:px-6">
        <SidebarTrigger className="-ml-1.5 md:hidden" />
        <Face persona={persona} size="md" speaking={speaking} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-base tracking-tight">{persona.name}</h2>
          <p className="flex items-center gap-1.5 text-muted-foreground text-sm">{state}</p>
        </div>
        {aside}
      </header>
      {children}
      <footer className="border-t bg-muted/50">
        <div className="mx-auto w-full max-w-3xl">{footer}</div>
      </footer>
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
  const { t } = useLingui();
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

  const placeholder =
    phase.name === "idle" || phase.name === "ended"
      ? t`Call ${ph({ name: short })} to start talking. You can speak or type.`
      : t`${ph({ name: short })} speaks first once the call connects.`;

  return (
    <>
      <h1 className="sr-only">{t`Call`}</h1>
      <Frame
        persona={persona}
        speaking={call.botSpeaking}
        state={<CallStatus phase={phase} name={short} />}
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
    </>
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
  const { t } = useLingui();
  return (
    <>
      <h1 className="sr-only">{t`Call`}</h1>
      <Frame
        persona={persona}
        speaking={false}
        state={<span className="truncate">{t`Not in a call`}</span>}
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
    </>
  );
}

export function CallPage() {
  const { t } = useLingui();
  const { data: status, refetch } = useQuery(statusQuery);
  const onEnded = useCallback(() => void refetch(), [refetch]);
  // The root loader primes it, so it is known from the first render.
  if (status === undefined) return null;

  const { persona } = status;
  const short = persona.shortName.trim() || persona.name;
  const missing = status.keys.filter((key) => !key.set);
  const names = listOf(missing.map((key) => key.name));
  if (missing.length > 0) {
    return (
      <Blocker
        persona={persona}
        media={
          <div className="flex size-24 items-center justify-center rounded-full bg-muted">
            <KeyRoundIcon className="size-9 text-muted-foreground" />
          </div>
        }
        title={t`Add your API keys first`}
        body={t`A call needs a key for each provider she uses. Missing: ${names}.`}
        to="/setup"
        icon={<KeyRoundIcon data-icon="inline-start" />}
        action={t`Add Keys`}
      />
    );
  }
  const problem = status.call.roles.find((role) => role.problem !== null);
  if (problem) {
    return (
      <Blocker
        persona={persona}
        media={
          <div className="flex size-24 items-center justify-center rounded-full bg-muted">
            <BrainIcon className="size-9 text-muted-foreground" />
          </div>
        }
        title={t`${ph({ name: short })}'s models need fixing`}
        body={problem.problem ?? ""}
        to={studioPath(persona.id, "models")}
        icon={<BrainIcon data-icon="inline-start" />}
        action={t`Open Her Models`}
      />
    );
  }
  // A realtime model speaks in its own voice, so only a call with a voice role needs one.
  if (persona.voice.id === null && !status.call.realtime) {
    return (
      <Blocker
        persona={persona}
        media={<Face persona={persona} size="xl" />}
        title={t`Pick a voice for ${ph({ name: short })}`}
        body={t`A call needs a voice. Pick one for her first.`}
        to={studioPath(persona.id, "voice")}
        icon={<AudioLinesIcon data-icon="inline-start" />}
        action={t`Pick a Voice`}
      />
    );
  }
  // A persona switch starts a fresh room: the server refuses one during a call.
  return <CallRoom key={persona.id} status={status} onEnded={onEnded} />;
}
