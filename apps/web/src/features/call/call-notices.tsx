import { CircleAlertIcon, InfoIcon, TriangleAlertIcon, Volume2Icon, XIcon } from "lucide-react";
import { Link } from "react-router";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { Status } from "@/lib/api";
import { type Translate, useT } from "@/lib/i18n";
import type { MicProblem } from "./media";
import { type CallEnd, sessionErrorSince } from "./phase";
import type { Call } from "./use-call";

interface Notice {
  readonly title: string;
  readonly detail?: string;
  /** The detail is untranslated text, such as the bot's own error message. */
  readonly verbatim?: boolean;
  readonly error: boolean;
}

function micNotice(problem: MicProblem, t: Translate): Notice {
  return {
    title: t(`call.mic.${problem}.title`),
    detail: t(`call.mic.${problem}.body`),
    error: true,
  };
}

/** Why the call ended, unless the viewer hung up; a session failure the bot recorded wins. */
function endNotice(end: CallEnd, sessionError: string | null, t: Translate): Notice | null {
  if (end.kind === "hung-up") return null;
  if (end.kind === "mic") return micNotice(end.problem, t);
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

function NoticeAlert({ notice }: { readonly notice: Notice }) {
  const Icon = notice.error ? CircleAlertIcon : InfoIcon;
  return (
    <Alert variant={notice.error ? "destructive" : "default"}>
      <Icon />
      <AlertTitle>{notice.title}</AlertTitle>
      {notice.detail && (
        <AlertDescription className={notice.verbatim ? "font-mono text-xs break-words" : undefined}>
          {notice.detail}
        </AlertDescription>
      )}
    </Alert>
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
  const ended = phase.name === "ended" ? phase : null;
  const end =
    ended && endNotice(ended.end, sessionErrorSince(status.lastSessionError, ended.startedAt), t);
  const inCall = phase.name === "connecting" || phase.name === "live";
  const mic = call.micProblem !== null && inCall ? micNotice(call.micProblem, t) : null;

  if (!end && !mic && !botError && !call.audioBlocked && status.persona.voice.ok !== false)
    return null;
  return (
    <div className="flex flex-col gap-2 border-b px-4 py-3">
      {end && <NoticeAlert notice={end} />}
      {mic && <NoticeAlert notice={mic} />}
      {call.audioBlocked && (
        <Alert>
          <Volume2Icon />
          <AlertTitle>{t("call.audio.blocked", { name })}</AlertTitle>
          <AlertAction>
            <Button size="sm" onClick={call.playAudio}>
              {t("call.audio.play")}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {botError && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{t("call.botError.title", { name })}</AlertTitle>
          <AlertDescription>
            <div>{t("call.botError.body")}</div>
            {botError.message && (
              <div className="font-mono text-xs break-words">{botError.message}</div>
            )}
            {botError.count > 1 && (
              <div className="text-xs">{t("call.botError.count", { count: botError.count })}</div>
            )}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={call.dismissBotError}
              aria-label={t("call.botError.dismiss")}
            >
              <XIcon />
            </Button>
          </AlertAction>
        </Alert>
      )}
      {status.persona.voice.ok === false && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>{t("call.voice.unknown", { name })}</AlertTitle>
          <AlertAction>
            <Button size="sm" variant="outline" asChild>
              <Link to={`/personas/${encodeURIComponent(status.persona.id)}/voice`}>
                {t("call.voice.pick")}
              </Link>
            </Button>
          </AlertAction>
        </Alert>
      )}
    </div>
  );
}
