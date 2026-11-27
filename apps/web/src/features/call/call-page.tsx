import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { AudioLinesIcon, BrainIcon, KeyRoundIcon } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MemoryStatus, Status } from "@/lib/api";
import { listOf } from "@/lib/labels";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { callBlocker } from "./blockers";
import { useCallPresence, useShellCall, useShowsCall } from "./call-context";
import { CallControls, MicPill } from "./call-controls";
import { CallNotices } from "./call-notices";
import { CallStatus, Face } from "./call-state";
import { soloCallView, soloTarget } from "./target";
import { TranscriptView } from "./transcript-view";
import { type CallHandle, NO_CALL } from "./use-call";
import { VideoCall } from "./video-call";

type Persona = Status["persona"];

function MemoryChip({ memory, name }: { readonly memory: MemoryStatus; readonly name: string }) {
  const { t } = useLingui();
  const on = memory.configured && memory.ready;
  const hint = !memory.configured
    ? t`Memory is off. Turn it on in Settings so ${name} remembers your calls.`
    : !memory.ready
      ? (memory.problem ??
        t`Memory needs its keys or settings fixed in Settings before ${name} can remember this call.`)
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
  ref,
  persona,
  speaking,
  state,
  aside,
  footer,
  children,
}: {
  readonly ref?: Ref<HTMLElement>;
  readonly persona: Persona;
  readonly speaking: boolean;
  readonly state: ReactNode;
  readonly aside?: ReactNode;
  /** Its controls; none while the video screen holds them. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section ref={ref} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
      <header className="flex items-center gap-3 border-b px-4 py-3 sm:px-6">
        <SidebarTrigger className="-ml-1.5 md:hidden shell:hidden" />
        <Face persona={persona} size="md" speaking={speaking} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-base tracking-tight">{persona.name}</h2>
          <p className="flex items-center gap-1.5 text-muted-foreground text-sm">{state}</p>
        </div>
        {aside}
      </header>
      {children}
      {footer !== undefined && footer !== null && (
        <footer className="border-t bg-muted/50">
          <div className="mx-auto w-full max-w-3xl">{footer}</div>
        </footer>
      )}
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

/** /call's own call; while a chat's is up, Call waits and the call bar leads back to it. */
function CallRoom({ status }: { readonly status: Status }) {
  const { t } = useLingui();
  const call = useShellCall();
  const { persona } = status;
  const { own, elsewhere, video } = soloCallView(call, persona.id);
  const shown: CallHandle = own ? call : NO_CALL;
  useShowsCall(own);
  const { phase } = shown;
  const short = persona.shortName.trim() || persona.name;
  const frame = useRef<HTMLElement>(null);
  // The screen goes with the focus when every stage failed or the call ended: the keyboard stays
  // in the call.
  const screened = useRef(video);
  useEffect(() => {
    if (screened.current && !video && document.activeElement === document.body) {
      frame.current?.focus({ preventScroll: true });
    }
    screened.current = video;
  }, [video]);

  const placeholder = elsewhere
    ? t`Hang up the call in your chat to call ${ph({ name: short })} here.`
    : phase.name === "idle" || phase.name === "ended"
      ? t`Call ${ph({ name: short })} to start talking. You can speak or type.`
      : t`${ph({ name: short })} speaks first once the call connects.`;

  return (
    <>
      <h1 className="sr-only">{t`Call`}</h1>
      <Frame
        ref={frame}
        persona={persona}
        speaking={shown.botSpeaking}
        state={<CallStatus phase={phase} name={short} />}
        aside={<MemoryChip memory={status.memory} name={short} />}
        footer={
          video ? null : (
            <CallControls
              call={shown}
              name={short}
              onStart={() => call.start(soloTarget(persona))}
              unavailable={elsewhere ? t`You're already in a call. Hang up first.` : null}
            />
          )
        }
      >
        {video ? (
          <VideoCall
            className="min-h-0 flex-1"
            status={status}
            titled={false}
            typing
            transcript={
              <TranscriptView
                transcript={call.transcript}
                wait={call.wait}
                name={short}
                intro={null}
              />
            }
          />
        ) : (
          <>
            <CallNotices call={shown} status={status} name={short} />
            <div className="relative min-h-0 flex-1">
              <TranscriptView
                transcript={shown.transcript}
                wait={shown.wait}
                name={short}
                intro={
                  <Intro
                    media={<Face persona={persona} size="xl" speaking={shown.botSpeaking} />}
                    title={
                      <p className="font-semibold text-xl tracking-tight">
                        {elsewhere ? t`You're in a call` : persona.name}
                      </p>
                    }
                    body={placeholder}
                  />
                }
              />
              <MicPill call={shown} />
            </div>
          </>
        )}
      </Frame>
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
  const { data: status } = useQuery(statusQuery);
  const { up } = useCallPresence();
  // The session gate primes it, so it is known from the first render.
  if (status === undefined) return null;

  const { persona } = status;
  const short = persona.shortName.trim() || persona.name;
  // What a call needs is asked before one starts: a status change during one never hides it.
  switch (up ? null : callBlocker(status)) {
    case "off":
      return (
        <Blocker
          persona={persona}
          media={<Face persona={persona} size="xl" />}
          title={t`Voice calls are turned off for ${ph({ name: short })}`}
          body={t`Speech or speech recognition is turned off in her settings, so she chats in text.`}
          to={studioPath(persona.id, persona.voice.provider === null ? "voice" : "models")}
          icon={<AudioLinesIcon data-icon="inline-start" />}
          action={t`Open Her Studio`}
        />
      );
    case "keys": {
      const names = listOf(status.keys.filter((key) => !key.set).map((key) => key.name));
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
    case "roles": {
      const problem = status.call.roles.find((role) => role.problem !== null)?.problem;
      return (
        <Blocker
          persona={persona}
          media={
            <div className="flex size-24 items-center justify-center rounded-full bg-muted">
              <BrainIcon className="size-9 text-muted-foreground" />
            </div>
          }
          title={t`${ph({ name: short })}'s models need fixing`}
          body={problem ?? ""}
          to={studioPath(persona.id, "models")}
          icon={<BrainIcon data-icon="inline-start" />}
          action={t`Open Her Models`}
        />
      );
    }
    case "voice":
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
  // The call is the shell's: a persona switch starts the page's own state afresh, and only that.
  return <CallRoom key={persona.id} status={status} />;
}
