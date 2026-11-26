import { MAX_PARTICIPANTS, type ParticipantId } from "@eidolon/chat";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { UserRoundMinusIcon, UserRoundPlusIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { PersonaAvatar } from "@/components/avatar";
import { monogram } from "@/components/avatar/monogram";
import { avatarSrc, useAvatarVersion } from "@/components/avatar/version";
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

const MAX_GROUP_AVATAR_TILES = 9;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function firstGrapheme(text: string): string {
  for (const { segment } of graphemeSegmenter.segment(text)) return segment;
  return "?";
}

/** WeChat-style row partitioning for up to 9 group chat tiles (`[2]`, `[1,2]`, ..., `[3,3,3]`). */
export function groupAvatarRows<T>(items: readonly T[]): readonly (readonly T[])[] {
  const shown = items.slice(0, MAX_GROUP_AVATAR_TILES);
  switch (shown.length) {
    case 0:
      return [];
    case 1:
    case 2:
      return [shown];
    case 3:
      return [shown.slice(0, 1), shown.slice(1)];
    case 4:
    case 5:
      return [shown.slice(0, 2), shown.slice(2)];
    case 6:
      return [shown.slice(0, 3), shown.slice(3)];
    case 7:
      return [shown.slice(0, 1), shown.slice(1, 4), shown.slice(4)];
    case 8:
      return [shown.slice(0, 2), shown.slice(2, 5), shown.slice(5)];
    default:
      return [shown.slice(0, 3), shown.slice(3, 6), shown.slice(6, 9)];
  }
}

function GroupAvatarTile({
  persona,
  compact,
}: {
  readonly persona: ChatPersona;
  readonly compact: boolean;
}) {
  const version = useAvatarVersion(persona.id);
  const src = avatarSrc(persona.id, version);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = persona.avatar !== false && failedSrc !== src;

  return (
    <span
      data-slot="group-avatar-tile"
      className={cn(
        "shrink-0 overflow-clip",
        compact ? "size-[calc(28px/3)] rounded-[1.5px]" : "size-[14.5px] rounded-[2px]",
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          onError={() => setFailedSrc(src)}
          className="block size-full object-cover"
        />
      ) : (
        <span
          className={cn(
            "flex size-full items-center justify-center bg-background/90 font-medium leading-none text-muted-foreground dark:bg-background/75",
            compact ? "text-[6px]" : "text-[8px]",
          )}
        >
          {firstGrapheme(monogram(persona.shortName || persona.name))}
        </span>
      )}
    </span>
  );
}

/** A chat's avatar in the list: hers alone, or a rounded-square grid of up to 9 group members. */
export function ChatAvatar({ personas }: { readonly personas: readonly ChatPersona[] }) {
  const [first] = personas;
  if (first === undefined) return null;
  if (personas.length === 1) return <PersonaAvatar persona={first} size="sm" />;

  const rows = groupAvatarRows(personas);
  const compact = personas.length >= 5;
  return (
    <span
      data-slot="group-avatar"
      aria-hidden
      className="relative flex size-8 shrink-0 flex-col items-center justify-center gap-px rounded-[6px] bg-black/[0.07] p-px select-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[6px] after:border after:border-border/50 after:mix-blend-darken dark:bg-white/[0.12] dark:after:mix-blend-lighten"
    >
      {rows.map((row) => (
        <span
          key={row.map((persona) => persona.id).join(",")}
          className="flex items-center justify-center gap-px"
        >
          {row.map((persona) => (
            <GroupAvatarTile key={persona.id} persona={persona} compact={compact} />
          ))}
        </span>
      ))}
    </span>
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
          <AvatarGroup>
            {inChat.slice(0, more > 0 ? SHOWN - 1 : SHOWN).map((persona) => (
              <PersonaAvatar key={persona.id} persona={persona} size="sm" />
            ))}
            {more > 0 && <AvatarGroupCount>+{more + 1}</AvatarGroupCount>}
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
