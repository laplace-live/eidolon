import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquareIcon, PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useNavigate } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { ListCard, ListRow } from "@/components/list";
import { personasQuery } from "@/components/settings-form/queries";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ApiError } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { ChatMenu } from "./chat-menu";
import { chatName, relativeTime } from "./format";
import { previewText } from "./items";
import { usePersonaOf } from "./persona";
import { chatsQuery, useCreateChat } from "./queries";

/** A list's relative times move on about this often. */
const CLOCK_MS = 30_000;

export function chatPath(id: string): string {
  return `/chats/${encodeURIComponent(id)}`;
}

/** New Chat: pick who it is with, the active persona first, then it opens. */
export function NewChatMenu({
  variant = "default",
  size = "default",
  className,
}: Pick<ComponentProps<typeof Button>, "variant" | "size" | "className">) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const personas = useQuery(personasQuery);
  const status = useQuery(statusQuery);
  const create = useCreateChat((id) => navigate(chatPath(id)));
  const active = status.data?.persona.id ?? personas.data?.active;
  const list = [...(personas.data?.personas ?? [])].sort(
    (a, b) => Number(b.id === active) - Number(a.id === active),
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size={size}
          className={className}
          disabled={create.isPending || list.length === 0}
        >
          {create.isPending ? <Spinner /> : <PlusIcon />}
          {t`New Chat`}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t`Chat With`}</DropdownMenuLabel>
        {list.map((persona) => (
          <DropdownMenuItem
            key={persona.id}
            className="gap-2 py-1.5"
            onSelect={() => create.mutate(persona.id)}
          >
            <PersonaAvatar persona={persona} size="xs" />
            <span className="truncate">{persona.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ListSkeleton() {
  const { t } = useLingui();
  return (
    <div role="status" aria-busy="true" className="divide-y">
      <span className="sr-only">{t`Loading…`}</span>
      {["a", "b", "c"].map((key) => (
        <div key={key} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3.5 w-44" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The chats, newest first, the open one lit. */
function ChatList({
  current,
  onDeleted,
}: {
  readonly current: string | undefined;
  readonly onDeleted: (id: string) => void;
}) {
  const { t } = useLingui();
  const lang = useLang();
  const now = useNow(true, CLOCK_MS);
  const chats = useQuery(chatsQuery);
  const personaOf = usePersonaOf();

  if (chats.isPending) return <ListSkeleton />;
  if (chats.error) {
    if (chats.error instanceof ApiError && chats.error.status === 401) return null;
    return (
      <div className="p-4">
        <ErrorAlert error={chats.error} />
      </div>
    );
  }
  if (chats.data.length === 0) {
    return (
      <EmptyState
        className="m-4"
        icon={<MessagesSquareIcon />}
        title={t`No chats yet`}
        description={t`Start one with any persona. Each chat keeps its own history.`}
      />
    );
  }
  return (
    <ListCard label={t`Chats`} className="rounded-none border-0 bg-transparent">
      {chats.data.map((chat) => {
        const persona = personaOf(chat.participants[0] ?? "");
        const name = chatName(chat.title, persona.name, chat.createdAt, lang, now);
        return (
          <ListRow
            key={chat.id}
            href={chatPath(chat.id)}
            className={cn("min-h-0 gap-x-3 px-4 py-3 sm:px-4", chat.id === current && "bg-muted")}
            leading={<PersonaAvatar persona={persona} size="sm" />}
            title={<span className="line-clamp-1 break-all">{name}</span>}
            description={
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {chat.lastText === null ? "" : previewText(chat.lastText)}
                </span>
                <time
                  dateTime={new Date(chat.updatedAt).toISOString()}
                  className="shrink-0 text-xs"
                >
                  {relativeTime(chat.updatedAt, now, lang)}
                </time>
              </span>
            }
            trailing={<ChatMenu id={chat.id} name={name} onDeleted={onDeleted} />}
          />
        );
      })}
    </ListCard>
  );
}

/** The list with its heading and New Chat: the page's left column, or a sheet on a phone. */
export function ChatListPanel({
  current,
  onDeleted,
  className,
}: {
  readonly current: string | undefined;
  readonly onDeleted: (id: string) => void;
  readonly className?: string;
}) {
  const { t } = useLingui();
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h2 className="font-semibold text-base tracking-tight">{t`Chats`}</h2>
        <NewChatMenu variant="outline" size="sm" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ChatList current={current} onDeleted={onDeleted} />
      </div>
    </div>
  );
}
