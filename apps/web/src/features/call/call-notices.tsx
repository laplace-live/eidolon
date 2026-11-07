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
import { type Translate, useT } from "@/lib/i18n";
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

function micEnding(problem: MicProblem, t: Translate): Ending {
  return {
    title: t(`call.mic.${problem}.title`),
    detail: t(`call.mic.${problem}.body`),
    error: true,
  };
}

/** Why the call ended, unless the viewer hung up; a session failure the bot recorded wins. */
function endingOf(end: CallEnd, sessionError: string | null, t: Translate): Ending | null {
  if (end.kind === "hung-up") return null;
  if (end.kind === "mic") return micEnding(end.problem, t);
  if (end.kind === "silence") return { title: t("call.ended.silence"), error: false };
  if (sessionError !== null && (end.kind === "connect" || end.kind === "dropped")) {
    return { title: t("call.ended.failed"), detail: sessionError, verbatim: true, error: true };
  }
  if (end.kind === "ice") {
    return { title: t("call.ended.ice"), detail: end.detail, verbatim: true, error: true };
  }
  if (end.kind === "dropped") {
    return { title: t(end.byBot ? "call.ended.byBot" : "call.ended.dropped"), error: true };
  }
  if (end.status === 401) {
    return { title: t("call.ended.connect"), detail: t("errors.unauthorized"), error: true };
  }
  if (end.status === 403) {
    return { title: t("call.ended.connect"), detail: t("errors.forbidden"), error: true };
  }
  return { title: t("call.ended.connect"), detail: end.detail, verbatim: true, error: true };
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
  const t = useT();
  const { phase, botError } = call;
  const { voice } = status.persona;
  const ended = phase.name === "ended" ? phase : null;
  const end =
    ended && endingOf(ended.end, sessionErrorSince(status.lastSessionError, ended.startedAt), t);
  const inCall = phase.name === "connecting" || phase.name === "live";
  const mic = call.micProblem !== null && inCall ? micEnding(call.micProblem, t) : null;

  if (!end && !mic && !botError && !call.audioBlocked && voice.ok !== false) return null;
  return (
    <div className="flex flex-col gap-2 border-b px-4 py-3 sm:px-6">
      {end && <EndingNotice ending={end} />}
      {mic && <EndingNotice ending={mic} />}
      {call.audioBlocked && (
        <Notice
          icon={Volume2Icon}
          tone="info"
          title={t("call.audio.blocked", { name })}
          action={
            <Button size="sm" onClick={call.playAudio}>
              {t("call.audio.play")}
            </Button>
          }
        />
      )}
      {botError && (
        <Notice
          icon={TriangleAlertIcon}
          tone="error"
          title={t("call.botError.title", { name })}
          onDismiss={call.dismissBotError}
          dismissLabel={t("call.botError.dismiss")}
        >
          <span className="flex flex-col gap-1">
            <span>{t("call.botError.body")}</span>
            {botError.message && (
              <span className="break-words font-mono text-xs">{botError.message}</span>
            )}
            {botError.count > 1 && (
              <span className="text-xs">{t("call.botError.count", { count: botError.count })}</span>
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
              ? t("call.voice.inheritedUnknown", { name })
              : t("call.voice.unknown", { name })
          }
          action={
            <Button size="sm" variant="outline" asChild>
              <Link to={studioPath(status.persona.id, "voice")}>{t("call.voice.pick")}</Link>
            </Button>
          }
        >
          {voice.source === "env" ? t("call.voice.inheritedHint") : undefined}
        </Notice>
      )}
    </div>
  );
}
