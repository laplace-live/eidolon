import { MAX_PARTICIPANTS, type ParticipantId } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { MessageSquarePlusIcon, OrbitIcon } from "lucide-react";
import { memo, type ReactElement, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { PersonaAvatar } from "@/components/avatar";
import { ErrorAlert } from "@/components/error-alert";
import { personasQuery } from "@/components/settings-form/queries";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar";
import { activeSubspaceServer, subspaceQuery } from "@/features/subspace/queries";
import { ApiError } from "@/lib/api";
import type { LocalChatSummary } from "@/lib/chats";
import { statusQuery } from "@/lib/query";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { type Lang, useLang } from "@/locales/i18n";
import { ChatMenu } from "./chat-menu";
import { chatName, relativeTime } from "./format";
import { previewText } from "./items";
import { ChatAvatar } from "./participants";
import { type ChatPersona, chatWith, usePersonaOf } from "./persona";
import { chatsQuery, useCreateChat } from "./queries";

/** A list's relative times move on about this often. */
const CLOCK_MS = 30_000;

export function chatPath(id: string): string {
  return `/chats/${encodeURIComponent(id)}`;
}

/** New Chat: tick who it is with, the active persona listed first, then start it. */
export function NewChatMenu({
  side = "bottom",
  align = "end",
  children,
}: {
  readonly side?: "bottom" | "right";
  readonly align?: "start" | "end";
  /** The button that opens it, told whether a chat is starting and whether it can open. */
  readonly children: (trigger: {
    readonly pending: boolean;
    readonly disabled: boolean;
  }) => ReactElement;
}) {
  const { t } = useLingui();
  const [, navigate] = useLocation();
  const personas = useQuery(personasQuery);
  const status = useQuery(statusQuery);
  const create = useCreateChat((id) => navigate(chatPath(id)));
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const active = status.data?.persona.id ?? personas.data?.active;
  const list = [...(personas.data?.personas ?? [])].sort(
    (a, b) => Number(b.id === active) - Number(a.id === active),
  );
  const picked = list.filter((persona) => chosen.has(persona.id)).map((persona) => persona.id);

  function toggle(id: string, on: boolean) {
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && setChosen(new Set())}>
      <DropdownMenuTrigger asChild>
        {children({ pending: create.isPending, disabled: create.isPending || list.length === 0 })}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="w-64">
        <DropdownMenuLabel>{t`Chat With`}</DropdownMenuLabel>
        {list.map((persona) => {
          const on = chosen.has(persona.id);
          return (
            <DropdownMenuCheckboxItem
              key={persona.id}
              className="gap-2 py-1.5"
              checked={on}
              disabled={!on && picked.length >= MAX_PARTICIPANTS}
              // Ticking keeps the menu open for the next.
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(next) => toggle(persona.id, next)}
            >
              <PersonaAvatar persona={persona} size="xs" />
              <span className="truncate">{persona.name}</span>
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={picked.length === 0} onSelect={() => create.mutate(picked)}>
          <MessageSquarePlusIcon />
          {picked.length > 1 ? t`Start Group Chat` : t`Start Chat`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatRow({
  chat,
  open,
  now,
  lang,
  personaOf,
  subspaceHost,
}: {
  readonly chat: LocalChatSummary;
  readonly open: boolean;
  readonly now: number;
  readonly lang: Lang;
  readonly personaOf: (id: ParticipantId) => ChatPersona;
  readonly subspaceHost: string | null;
}) {
  const { t } = useLingui();
  const personas = chat.participants.map(personaOf);
  const name = chatName(chat.title, chatWith(personas), chat.createdAt, lang, now);
  // An open chat is being marked read; suppress its badge immediately on selection.
  const unread = open ? 0 : chat.unread;
  const unreadLabel = unread > 0 ? t`, ${ph({ count: unread })} unread` : "";
  const baseTooltip = unread > 0 ? `${name}${unreadLabel}` : name;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        size="lg"
        isActive={open}
        tooltip={subspaceHost === null ? baseTooltip : `${baseTooltip} · ${subspaceHost}`}
        className="h-auto gap-2.5 py-1.5 data-active:font-normal"
      >
        <Link to={chatPath(chat.id)}>
          <ChatAvatar personas={personas} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline gap-2">
              {subspaceHost !== null && (
                <OrbitIcon
                  data-subspace-chat
                  aria-hidden
                  className="size-3.5 shrink-0 self-center text-primary"
                />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
              {/* Its time gives way to its menu, which a touch screen always shows. */}
              <time
                dateTime={new Date(chat.updatedAt).toISOString()}
                className="shrink-0 text-sidebar-foreground/60 text-xs group-hover/menu-item:invisible group-has-focus-visible/menu-item:invisible group-has-data-[state=open]/menu-item:invisible pointer-coarse:invisible"
              >
                {relativeTime(chat.updatedAt, now, lang)}
              </time>
            </span>
            <span className="flex min-h-4 items-center gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  unread > 0 ? "font-medium text-sidebar-foreground" : "text-sidebar-foreground/60",
                )}
              >
                {chat.lastText === null ? "" : previewText(chat.lastText)}
              </span>
              {unread > 0 && (
                <span
                  data-unread-count
                  className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 font-medium text-[11px] text-primary-foreground leading-none tabular-nums"
                >
                  <span aria-hidden>{unread > 99 ? "99+" : unread}</span>
                  <span className="sr-only">{unreadLabel}</span>
                </span>
              )}
            </span>
          </span>
        </Link>
      </SidebarMenuButton>
      {unread > 0 && (
        <span
          data-unread-dot
          aria-hidden
          className="pointer-events-none absolute top-0.5 right-0.5 hidden size-2 rounded-full bg-primary ring-2 ring-sidebar group-data-[collapsible=icon]:block"
        />
      )}
      <ChatMenu
        id={chat.id}
        name={name}
        className="absolute top-1.5 right-1.5 size-6 opacity-0 hover:bg-sidebar-border group-hover/menu-item:opacity-100 group-has-focus-visible/menu-item:opacity-100 group-data-[collapsible=icon]:hidden data-[state=open]:opacity-100 pointer-coarse:opacity-100 dark:hover:bg-sidebar-border"
      />
    </SidebarMenuItem>
  );
}

/**
 * The sidebar's chats, newest first, the open one lit; their avatars alone while it is collapsed.
 * Memoized: the sidebar re-renders on every tasks and status poll, which changes no row.
 */
export const SidebarChats = memo(function SidebarChats() {
  const { t } = useLingui();
  const lang = useLang();
  const personaOf = usePersonaOf();
  const now = useNow(true, CLOCK_MS);
  const chats = useQuery(chatsQuery);
  const subspaceHost =
    useQuery({
      ...subspaceQuery,
      select: (state) => activeSubspaceServer(state)?.name ?? null,
    }).data ?? null;
  const [, match] = useRoute("/chats/:id");
  const current = match?.id;

  if (chats.error instanceof ApiError && chats.error.status === 401) return null;

  return (
    <SidebarGroup>
      <SidebarGroupLabel
        asChild
        className="hover:text-sidebar-foreground group-data-[collapsible=icon]:invisible"
      >
        <Link to="/chats">{t`Chats`}</Link>
      </SidebarGroupLabel>
      {chats.isPending ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-0.5">
          <span className="sr-only">{t`Loading…`}</span>
          {["a", "b", "c"].map((key) => (
            <SidebarMenuSkeleton key={key} showIcon className="h-12" />
          ))}
        </div>
      ) : chats.isError ? (
        <div className="group-data-[collapsible=icon]:hidden">
          <ErrorAlert error={chats.error} />
        </div>
      ) : chats.data.length === 0 ? (
        <p className="px-2 text-sidebar-foreground/60 text-xs group-data-[collapsible=icon]:hidden">
          {t`No chats yet`}
        </p>
      ) : (
        <SidebarMenu aria-label={t`Chats`} className="gap-0.5">
          {chats.data.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              open={chat.id === current}
              now={now}
              lang={lang}
              personaOf={personaOf}
              subspaceHost={subspaceHost}
            />
          ))}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
});
