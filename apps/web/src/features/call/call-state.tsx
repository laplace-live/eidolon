import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { PersonaAvatar, type PersonaAvatarProps } from "@/components/avatar";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { formatDuration } from "./format";
import type { CallPhase } from "./phase";

/** The call's state; only this line renders each second while the call runs. */
function CallState({ phase, name }: { readonly phase: CallPhase; readonly name: string }) {
  const { t } = useLingui();
  const now = useNow(phase.name === "live" && phase.answeredAt !== null);
  switch (phase.name) {
    case "idle":
      return t`Not in a call`;
    case "starting":
      return t`Getting your microphone ready…`;
    case "connecting":
      return t`Calling…`;
    case "live":
      return phase.answeredAt === null
        ? t`Waiting for ${name} to answer…`
        : t`In a call · ${ph({ duration: formatDuration(now - phase.answeredAt) })}`;
    case "ending":
      return t`Hanging up…`;
    case "ended":
      return phase.answeredAt === null
        ? t`Call ended`
        : t`Call ended · ${ph({ duration: formatDuration(phase.endedAt - phase.answeredAt) })}`;
  }
}

/** How the call stands, after a spinner while it waits or a green dot once she has answered. */
export function CallStatus({ phase, name }: { readonly phase: CallPhase; readonly name: string }) {
  const waiting =
    phase.name === "starting" ||
    phase.name === "connecting" ||
    phase.name === "ending" ||
    (phase.name === "live" && phase.answeredAt === null);
  const answered = phase.name === "live" && phase.answeredAt !== null;
  return (
    <>
      {waiting && <Spinner className="size-3.5 shrink-0" />}
      {answered && <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />}
      <span className="truncate">
        <CallState phase={phase} name={name} />
      </span>
    </>
  );
}

/** Her avatar, ringed while she speaks. */
export function Face({
  persona,
  size,
  speaking = false,
}: {
  readonly persona: PersonaAvatarProps["persona"];
  readonly size: "sm" | "md" | "xl";
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
