// A call inside a chat, docked above the composer: the call page's state line, notices, mic and
// hang-up, while what is said lands in the chat's log as messages.
import type { ParticipantId } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { PhoneIcon, UsersIcon, XIcon } from "lucide-react";
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
import { HangUpButton, MicToggle } from "@/features/call/call-controls";
import { CallNotices } from "@/features/call/call-notices";
import { CallStatus, Face } from "@/features/call/call-state";
import type { Call } from "@/features/call/use-call";
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
  onCall,
}: {
  /** Who is in the chat now. */
  readonly personas: readonly ChatPersona[];
  /** Whether they can all be called at once. */
  readonly groupCall: boolean;
  readonly disabled: boolean;
  readonly onCall: (persona: ParticipantId, group: boolean) => void;
}) {
  const { t } = useLingui();
  const [only] = personas;
  const label = <span className="max-sm:sr-only">{t`Call`}</span>;
  if (only === undefined) return null;
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

/**
 * The call with her, or with everyone: how it stands, what went wrong, and the mic and hang-up. A
 * call that ended on its own stays docked with why, until the viewer calls again or closes it.
 */
export function CallDock({
  call,
  persona,
  group,
  status,
  onCallAgain,
  onClose,
}: {
  readonly call: Call;
  /** Whom the viewer called; on a group call, the host. */
  readonly persona: ChatPersona;
  /** Everyone on a group call; null on a call with her alone. */
  readonly group: readonly ChatPersona[] | null;
  /** For why the call failed on Eidolon's side, and her voice's check while she is active. */
  readonly status: Status | undefined;
  readonly onCallAgain: () => void;
  readonly onClose: () => void;
}) {
  const { t } = useLingui();
  const { phase, botSpeaking } = call;
  const { speaker } = call.transcript;
  const name = group === null ? shortNameOf(persona) : listOf(group.map(shortNameOf));
  // On a group call, whom the speaker label says the viewer hears, or heard last.
  const voice = speaker === null ? undefined : group?.find((each) => each.id === speaker.persona);
  const over = phase.name === "idle" || phase.name === "ended";
  return (
    <section
      aria-label={t`Call with ${name}`}
      className="overflow-hidden rounded-xl border bg-card text-card-foreground"
    >
      {status !== undefined && (
        <CallNotices call={call} status={status} name={name} persona={persona.id} />
      )}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <Face persona={voice ?? persona} size="sm" speaking={botSpeaking} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm leading-tight">
            {group === null
              ? persona.name
              : botSpeaking && voice !== undefined
                ? t`${ph({ name: shortNameOf(voice) })} is speaking`
                : t`Everyone`}
          </p>
          <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <CallStatus phase={phase} name={name} />
          </p>
        </div>
        {over ? (
          <>
            <Button variant="outline" size="sm" onClick={onCallAgain}>
              <PhoneIcon />
              {t`Call Again`}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={t`Close`} onClick={onClose}>
              <XIcon />
            </Button>
          </>
        ) : (
          <>
            <MicToggle call={call} />
            <HangUpButton call={call} />
          </>
        )}
      </div>
    </section>
  );
}
