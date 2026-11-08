import { msg, ph, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  CircleAlertIcon,
  InfoIcon,
  type LucideIcon,
  TriangleAlertIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Status } from "@/lib/api";
import { studioPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import type { MicProblem } from "./media";
import { type CallEnd, sessionErrorSince } from "./phase";
import type { Call } from "./use-call";

interface Ending {
  readonly title: string;
  readonly detail?: string;
  /** The detail is untranslated text, such as the bot's own error message. */
  readonly verbatim?: boolean;
  readonly error: boolean;
}

const MIC_PROBLEMS = {
  denied: {
    title: msg`Your microphone is blocked`,
    body: msg`Allow microphone access for this page in your browser's site settings, then call again.`,
  },
  busy: {
    title: msg`Your microphone is in use`,
    body: msg`Another app is using your microphone. Close it, then call again.`,
  },
  missing: {
    title: msg`No microphone found`,
    body: msg`Connect a microphone, then call again.`,
  },
  insecure: {
    title: msg`The microphone isn't available here`,
    body: msg`Browsers allow the microphone only on secure pages. Open Eidolon at http://localhost or http://127.0.0.1.`,
  },
  unknown: {
    title: msg`Your microphone didn't start`,
    body: msg`Check your microphone, then call again.`,
  },
} satisfies Record<MicProblem, unknown>;

function micEnding(problem: MicProblem): Ending {
  return {
    title: t(MIC_PROBLEMS[problem].title),
    detail: t(MIC_PROBLEMS[problem].body),
    error: true,
  };
}

/** Why the call ended, unless the viewer hung up; a session failure the bot recorded wins. */
function endingOf(end: CallEnd, sessionError: string | null): Ending | null {
  if (end.kind === "hung-up") return null;
  if (end.kind === "mic") return micEnding(end.problem);
  if (end.kind === "silence")
    return { title: t`The call ended after 5 minutes of silence.`, error: false };
  if (sessionError !== null && (end.kind === "connect" || end.kind === "dropped")) {
    return {
      title: t`The call failed on Eidolon's side.`,
      detail: sessionError,
      verbatim: true,
      error: true,
    };
  }
  if (end.kind === "ice") {
    return {
      title: t`Couldn't get the connection settings for the call.`,
      detail: end.detail,
      verbatim: true,
      error: true,
    };
  }
  if (end.kind === "dropped") {
    return {
      title: end.byBot ? t`Eidolon ended the call.` : t`The connection dropped.`,
      error: true,
    };
  }
  if (end.status === 401) {
    return {
      title: t`Couldn't connect the call.`,
      detail: t`This page isn't signed in. Open the link from the terminal.`,
      error: true,
    };
  }
  if (end.status === 403) {
    return {
      title: t`Couldn't connect the call.`,
      detail: t`The request was refused.`,
      error: true,
    };
  }
  return { title: t`Couldn't connect the call.`, detail: end.detail, verbatim: true, error: true };
}

const TONE_ICON_CLASS = {
  error: "text-destructive",
  warning: "text-warning",
  info: "text-muted-foreground",
} as const;

/** One notice: an icon, a line, an optional detail, and a button at its end. */
function Notice({
  icon: Icon,
  tone,
  title,
  children,
  action,
  onDismiss,
  dismissLabel,
}: {
  readonly icon: LucideIcon;
  readonly tone: keyof typeof TONE_ICON_CLASS;
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly onDismiss?: () => void;
  readonly dismissLabel?: string;
}) {
  return (
    <Alert
      variant={tone === "error" ? "destructive" : "default"}
      className={cn(
        "flex flex-wrap items-start gap-x-2.5 gap-y-2 px-3 py-2.5",
        onDismiss && "pr-10",
      )}
    >
      {/* Wrapped: the alert recolours an svg child to its own text colour. */}
      <span className={cn("mt-0.5 flex shrink-0", TONE_ICON_CLASS[tone])}>
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <AlertTitle>{title}</AlertTitle>
        {children !== undefined && <AlertDescription>{children}</AlertDescription>}
      </div>
      {action !== undefined && (
        <div className="ml-6.5 flex shrink-0 items-center sm:ml-0 sm:self-center">{action}</div>
      )}
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="absolute top-2 right-2"
          onClick={onDismiss}
          aria-label={dismissLabel}
        >
          <XIcon />
        </Button>
      )}
    </Alert>
  );
}

function EndingNotice({ ending }: { readonly ending: Ending }) {
  return (
    <Notice
      icon={ending.error ? CircleAlertIcon : InfoIcon}
      tone={ending.error ? "error" : "info"}
      title={ending.title}
    >
      {ending.detail && (
        <span className={ending.verbatim ? "break-words font-mono text-xs" : undefined}>
          {ending.detail}
        </span>
      )}
    </Notice>
  );
}

/** What the viewer should know about the call: why it ended, a mic problem, the bot's errors. */
export function CallNotices({
  call,
  status,
  name,
}: {
  readonly call: Call;
  readonly status: Status;
  /** The persona's short name. */
  readonly name: string;
}) {
  const { t } = useLingui();
  const { phase, botError } = call;
  const { voice } = status.persona;
  const ended = phase.name === "ended" ? phase : null;
  const end =
    ended && endingOf(ended.end, sessionErrorSince(status.lastSessionError, ended.startedAt));
  const inCall = phase.name === "connecting" || phase.name === "live";
  const mic = call.micProblem !== null && inCall ? micEnding(call.micProblem) : null;

  if (!end && !mic && !botError && !call.audioBlocked && voice.ok !== false) return null;
  return (
    <div className="flex flex-col gap-2 border-b px-4 py-3 sm:px-6">
      {end && <EndingNotice ending={end} />}
      {mic && <EndingNotice ending={mic} />}
      {call.audioBlocked && (
        <Notice
          icon={Volume2Icon}
          tone="info"
          title={t`Your browser is holding back ${name}'s voice.`}
          action={
            <Button size="sm" onClick={call.playAudio}>
              {t`Play`}
            </Button>
          }
        />
      )}
      {botError && (
        <Notice
          icon={TriangleAlertIcon}
          tone="error"
          title={t`${name} ran into an error`}
          onDismiss={call.dismissBotError}
          dismissLabel={t`Dismiss`}
        >
          <span className="flex flex-col gap-1">
            <span>{t`One of her providers reported a problem. Check its key and credit in Settings.`}</span>
            {botError.message && (
              <span className="break-words font-mono text-xs">{botError.message}</span>
            )}
            {botError.count > 1 && (
              <span className="text-xs">{t`${ph({ count: botError.count })} errors this call`}</span>
            )}
          </span>
        </Notice>
      )}
      {voice.ok === false && (
        <Notice
          icon={TriangleAlertIcon}
          tone="warning"
          title={
            voice.source === "env"
              ? t`Fish Audio can't use the voice ${name} inherits from the environment, so calls may have no sound.`
              : t`Fish Audio can't use ${name}'s voice, so calls may have no sound.`
          }
          action={
            <Button size="sm" variant="outline" asChild>
              <Link to={studioPath(status.persona.id, "voice")}>{t`Pick a Voice`}</Link>
            </Button>
          }
        >
          {voice.source === "env"
            ? t`Pick her own voice: it overrides the environment's for her alone.`
            : undefined}
        </Notice>
      )}
    </div>
  );
}
