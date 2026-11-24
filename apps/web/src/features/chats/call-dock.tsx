// A call inside a chat, docked above the composer: the call page's state line, notices, mic and
// hang-up, while what is said lands in the chat's log as messages.
import type { ParticipantId } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Maximize2Icon, PhoneIcon, UsersIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { PersonaAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UnavailableButton } from "@/components/unavailable-button";
import { AvatarView } from "@/features/call/avatar-view";
import { useShellCall, useShowsCall } from "@/features/call/call-context";
import { HangUpButton, MicToggle } from "@/features/call/call-controls";
import { CallNotices } from "@/features/call/call-notices";
import { CallStatus, Face } from "@/features/call/call-state";
import { type CastMember, hostOf, isUp } from "@/features/call/target";
import type { Status } from "@/lib/api";
import { listOf } from "@/lib/labels";
import { type ChatPersona, shortNameOf } from "./persona";

/**
 * The header's Call: her, in a chat of one; in a group, whichever participant the viewer picks, or
 * everyone at once where the server can call them together, the first of them hearing the viewer.
 */
export function CallButton({
  personas,
  groupCall,
  disabled,
  unavailable = null,
  onCall,
}: {
  /** Who is in the chat now. */
  readonly personas: readonly ChatPersona[];
  /** Whether they can all be called at once. */
  readonly groupCall: boolean;
  readonly disabled: boolean;
  /** Why no call can be placed here now, shown in its tooltip; null while one can. */
  readonly unavailable?: string | null;
  readonly onCall: (persona: ParticipantId, group: boolean) => void;
}) {
  const { t } = useLingui();
  const [only] = personas;
  const label = <span className="max-sm:sr-only">{t`Call`}</span>;
  if (only === undefined) return null;
  if (unavailable !== null) {
    return (
      <UnavailableButton variant="outline" size="sm" reason={unavailable}>
        <PhoneIcon />
        {label}
      </UnavailableButton>
    );
  }
  if (personas.length === 1) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onCall(only.id, false)}
      >
        <PhoneIcon />
        {label}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <PhoneIcon />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t`Who to Call`}</DropdownMenuLabel>
        {groupCall && (
          <>
            <DropdownMenuItem className="gap-2 py-1.5" onSelect={() => onCall(only.id, true)}>
              <UsersIcon />
              <span className="truncate">{t`Everyone`}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {personas.map((persona) => (
          <DropdownMenuItem
            key={persona.id}
            className="gap-2 py-1.5"
            onSelect={() => onCall(persona.id, false)}
          >
            <PersonaAvatar persona={persona} size="xs" />
            <span className="truncate">{persona.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Her model in the dock, which opens the call's screen again. */
function Expand({
  member,
  onExpand,
}: {
  readonly member: CastMember;
  readonly onExpand: () => void;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLButtonElement>(null);
  // Shrink's button went with the screen, leaving the focus on the body. The log's effects run
  // after this one, so a task to show then moves it on to its card.
  useEffect(() => {
    if (document.activeElement === document.body) ref.current?.focus();
  }, []);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={t`Expand`}
      onClick={onExpand}
      className="relative h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-muted"
    >
      <AvatarView member={member} face="sm" className="absolute inset-0" />
      <span className="absolute right-0.5 bottom-0.5 flex size-4 items-center justify-center rounded-sm bg-background/80 text-foreground">
        <Maximize2Icon className="size-3" />
      </span>
    </button>
  );
}

/**
 * The tab's call in this chat, with her alone or with everyone: how it stands, what went wrong,
 * and the mic and hang-up. With her model, its picture is her model live, which opens the screen.
 * A call that ended on its own stays docked with why, until the viewer calls again or closes it.
 */
export function CallDock({
  status,
  onCallAgain,
}: {
  /** For why the call failed on Eidolon's side, and her voice's check while she is active. */
  readonly status: Status | undefined;
  readonly onCallAgain: () => void;
}) {
  const { t } = useLingui();
  const call = useShellCall();
  useShowsCall();
  const root = useRef<HTMLElement>(null);
  // Nothing holds the focus once the screen goes with no Expand to take it, every stage having
  // failed or the call ended, and the bar's link still holds it as Return to Call brings the dock
  // back. Expand's effect runs first, so Shrink still lands there.
  useEffect(() => {
    const held = document.activeElement;
    if (held === document.body || held?.closest("[data-call-bar]")) {
      root.current?.focus({ preventScroll: true });
    }
  }, []);
  const { target, phase, botSpeaking } = call;
  if (target === null) return null;
  const host = hostOf(target);
  const group = target.kind === "chat" && target.group;
  const name = group ? listOf(target.cast.map(shortNameOf)) : shortNameOf(host);
  // On a group call, whom the speaker label says the viewer hears, or heard last.
  const { speaker } = call.transcript;
  const voice =
    group && speaker !== null
      ? target.cast.find((member) => member.id === speaker.persona)
      : undefined;
  const up = isUp(phase);
  return (
    <section
      ref={root}
      aria-label={t`Call with ${name}`}
      tabIndex={-1}
      className="overflow-hidden rounded-xl border bg-card text-card-foreground outline-none"
    >
      {status !== undefined && (
        <CallNotices call={call} status={status} name={name} persona={host.id} />
      )}
      <div className="flex items-center gap-3 px-3 py-2.5">
        {up && call.video ? (
          <Expand member={voice ?? host} onExpand={() => call.setLayout("screen")} />
        ) : (
          <Face persona={voice ?? host} size="sm" speaking={botSpeaking} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm leading-tight">
            {!group
              ? host.name
              : botSpeaking && voice !== undefined
                ? t`${ph({ name: shortNameOf(voice) })} is speaking`
                : t`Everyone`}
          </p>
          <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <CallStatus phase={phase} name={name} />
          </p>
        </div>
        {up ? (
          <>
            <MicToggle call={call} />
            <HangUpButton call={call} />
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={onCallAgain}>
              <PhoneIcon />
              {t`Call Again`}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t`Close`} onClick={call.close}>
              <XIcon />
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
