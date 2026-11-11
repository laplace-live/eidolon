import { MAX_PARTICIPANTS, type ParticipantId } from "@eidolon/chat";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { UserRoundMinusIcon, UserRoundPlusIcon } from "lucide-react";
import { Link } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { personasQuery } from "@/components/settings-form/queries";
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { studioPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import type { ChatPersona } from "./persona";
import { useChangeParticipants } from "./queries";

/** Two fit the box one avatar fills, so their monograms shrink with them. */
const SMALL = "size-5 *:data-[slot=avatar-fallback]:text-[0.5rem]";

/** A chat's avatar in the list: hers alone, or two of a group's, overlapping in the same box. */
export function ChatAvatar({ personas }: { readonly personas: readonly ChatPersona[] }) {
  const [first, second] = personas;
  if (first === undefined) return null;
  if (second === undefined) return <PersonaAvatar persona={first} size="sm" />;
  return (
    <div className="relative size-8 shrink-0">
      <PersonaAvatar persona={first} size="xs" className={cn(SMALL, "absolute top-0 left-0")} />
      <PersonaAvatar
        persona={second}
        size="xs"
        className={cn(SMALL, "absolute right-0 bottom-0 ring-2 ring-card")}
      />
    </div>
  );
}

const SHOWN = 3;

/** A menu item's look when disabled, which the sub-menu trigger lacks. */
const DISABLED = "data-disabled:pointer-events-none data-disabled:opacity-50";

/** The header's avatars, opening who is in the chat, with Add and Remove. */
export function ParticipantsMenu({
  chatId,
  participants,
  personaOf,
}: {
  readonly chatId: string;
  readonly participants: readonly ParticipantId[];
  readonly personaOf: (id: ParticipantId) => ChatPersona;
}) {
  const { t } = useLingui();
  const personas = useQuery(personasQuery);
  const change = useChangeParticipants();
  const inChat = participants.map(personaOf);
  const others = (personas.data?.personas ?? []).filter(
    (persona) => !participants.includes(persona.id),
  );
  const more = inChat.length - SHOWN;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t`Participants`}
          className="shrink-0 rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <AvatarGroup className="*:data-[slot=avatar]:ring-card">
            {inChat.slice(0, more > 0 ? SHOWN - 1 : SHOWN).map((persona) => (
              <PersonaAvatar key={persona.id} persona={persona} size="sm" />
            ))}
            {more > 0 && <AvatarGroupCount className="ring-card">+{more + 1}</AvatarGroupCount>}
          </AvatarGroup>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t`In This Chat`}</DropdownMenuLabel>
        {inChat.map((persona) => (
          <DropdownMenuItem key={persona.id} className="gap-2 py-1.5" asChild>
            <Link to={studioPath(persona.id)}>
              <PersonaAvatar persona={persona} size="xs" />
              <span className="truncate">{persona.name}</span>
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            disabled={participants.length >= MAX_PARTICIPANTS || others.length === 0}
            className={DISABLED}
          >
            <UserRoundPlusIcon />
            {t`Add Persona`}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            {others.map((persona) => (
              <DropdownMenuItem
                key={persona.id}
                className="gap-2 py-1.5"
                disabled={change.isPending}
                onSelect={() => change.mutate({ id: chatId, add: [persona.id] })}
              >
                <PersonaAvatar persona={persona} size="xs" />
                <span className="truncate">{persona.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={participants.length <= 1} className={DISABLED}>
            <UserRoundMinusIcon />
            {t`Remove Persona`}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            {inChat.map((persona) => (
              <DropdownMenuItem
                key={persona.id}
                className="gap-2 py-1.5"
                disabled={change.isPending}
                onSelect={() => change.mutate({ id: chatId, remove: [persona.id] })}
              >
                <PersonaAvatar persona={persona} size="xs" />
                <span className="truncate">{persona.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
