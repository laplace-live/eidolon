import { summarize } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon, MessageSquareOffIcon, PanelLeftIcon, PhoneIcon } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, type ErrorCode } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { useLang } from "@/locales/i18n";
import { ChatLog } from "./chat-log";
import { ChatMenu } from "./chat-menu";
import { Composer } from "./composer";
import { chatName, shortDate } from "./format";
import { chatItems, retryText } from "./items";
import { type ChatPersona, shortNameOf, usePersonaOf } from "./persona";
import { chatQuery } from "./queries";
import type { LiveError } from "./stream";
import { useChat } from "./use-chat";

/** A call reaches only the active persona for now, so the button waits for her to be active. */
function CallButton({ persona }: { readonly persona: ChatPersona }) {
  const { t } = useLingui();
  const { data: status } = useQuery(statusQuery);
  const label = <span className="max-sm:sr-only">{t`Call`}</span>;
  if (status?.persona.id === persona.id) {
    return (
      <Button variant="outline" size="sm" asChild>
        <Link to="/call">
          <PhoneIcon />
          {label}
        </Link>
      </Button>
    );
  }
  // aria-disabled rather than disabled, which would take the tooltip's hover and focus too.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-disabled
          className="cursor-not-allowed opacity-50 hover:bg-card"
          onClick={(event) => event.preventDefault()}
        >
          <PhoneIcon />
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{t`Calls use the active persona for now.`}</TooltipContent>
    </Tooltip>
  );
}

/** A reply that couldn't start: a key she needs, else the API's failure. */
function LiveNotice({ error, name }: { readonly error: LiveError; readonly name: string }) {
  const { t } = useLingui();
  if (error.code === "missing-key") {
    return (
      <Alert>
        <KeyRoundIcon />
        <AlertTitle>{t`${ph({ name })} can't answer yet`}</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
        <AlertAction>
          <Button variant="outline" size="sm" asChild>
            <Link to="/settings?tab=providers">{t`Add Keys`}</Link>
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return <ErrorAlert error={new ApiError(0, error.code as ErrorCode, error.message)} />;
}

/** Opens the list, which a phone keeps in a sheet. */
function ListButton({ onClick }: { readonly onClick: () => void }) {
  const { t } = useLingui();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="md:hidden"
      aria-label={t`Show Chats`}
      onClick={onClick}
    >
      <PanelLeftIcon />
    </Button>
  );
}

/** The pane while there is no chat to show: loading, gone, or failed. */
export function ChatPlaceholder({
  state,
  onShowList,
}: {
  readonly state: "loading" | "missing" | Error;
  readonly onShowList: () => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <div className="flex h-14 shrink-0 items-center border-b px-4">
        <ListButton onClick={onShowList} />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {state === "loading" ? (
          <Spinner className="size-6 text-muted-foreground" />
        ) : state === "missing" ? (
          <EmptyState
            className="border-0"
            icon={<MessageSquareOffIcon />}
            title={t`This chat doesn't exist`}
            description={t`It may have been deleted. Pick another, or start a new one.`}
          />
        ) : (
          <div className="w-full max-w-lg">
            <ErrorAlert error={state} />
          </div>
        )}
      </div>
    </>
  );
}

export function ChatView({
  id,
  onShowList,
  onDeleted,
}: {
  readonly id: string;
  readonly onShowList: () => void;
  readonly onDeleted: (id: string) => void;
}) {
  const lang = useLang();
  const chat = useQuery(chatQuery(id));
  const personaOf = usePersonaOf();
  const turns = useChat(id);
  const events = chat.data?.events;
  const items = useMemo(() => chatItems(events ?? []), [events]);

  if (chat.data === undefined) {
    const state =
      chat.error === null
        ? "loading"
        : chat.error instanceof ApiError && chat.error.status === 404
          ? "missing"
          : chat.error;
    return <ChatPlaceholder state={state} onShowList={onShowList} />;
  }

  const { header } = chat.data;
  const persona = personaOf(header.participants[0] ?? "");
  const name = shortNameOf(persona);
  const { title } = summarize(header, chat.data.events);
  const now = Date.now();
  const menuName = chatName(title, persona.name, header.createdAt, lang, now);
  const retry = turns.busy ? null : retryText(items);

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <ListButton onClick={onShowList} />
        <PersonaAvatar persona={persona} size="sm" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-sm leading-tight">{title ?? persona.name}</h2>
          <p className="truncate text-muted-foreground text-xs">
            {title === null ? shortDate(header.createdAt, lang, now) : persona.name}
          </p>
        </div>
        <CallButton persona={persona} />
        <ChatMenu id={id} name={menuName} onDeleted={onDeleted} />
      </header>
      <div className="relative min-h-0 flex-1">
        <ChatLog
          chatId={id}
          persona={persona}
          items={items}
          live={turns.live}
          lateTools={chat.data.lateTools}
          retry={retry}
          onSend={turns.send}
        />
      </div>
      <footer className="flex shrink-0 flex-col gap-3 border-t bg-muted/50 px-4 py-3">
        {turns.live.error !== null && <LiveNotice error={turns.live.error} name={name} />}
        <Composer name={name} busy={turns.busy} onSend={turns.send} onStop={turns.stop} />
      </footer>
    </>
  );
}
