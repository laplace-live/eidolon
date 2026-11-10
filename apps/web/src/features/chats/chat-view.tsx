import { chainLimitOf, summarize } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon, MessageSquareOffIcon, PanelLeftIcon, PhoneIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, type ErrorCode } from "@/lib/api";
import { listOf } from "@/lib/labels";
import { statusQuery } from "@/lib/query";
import { useLang } from "@/locales/i18n";
import { ChatLog } from "./chat-log";
import { ChatMenu } from "./chat-menu";
import { ChatSettingsSheet } from "./chat-settings";
import { Composer } from "./composer";
import { chatName, shortDate } from "./format";
import { nextUp } from "./group";
import { chatItems, retryText } from "./items";
import { ParticipantsMenu } from "./participants";
import { type ChatPersona, chatWith, shortNameOf, usePersonaOf } from "./persona";
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
function LiveNotice({
  error,
  name,
}: {
  readonly error: LiveError;
  /** Hers in a chat with one persona; null in a group, where the message names who. */
  readonly name: string | null;
}) {
  const { t } = useLingui();
  if (error.code === "missing-key") {
    return (
      <Alert>
        <KeyRoundIcon />
        <AlertTitle>
          {name === null ? t`Someone here can't answer yet` : t`${ph({ name })} can't answer yet`}
        </AlertTitle>
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
  const { t } = useLingui();
  const lang = useLang();
  const chat = useQuery(chatQuery(id));
  const personaOf = usePersonaOf();
  const turns = useChat(id);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const events = chat.data?.events;
  const items = useMemo(() => chatItems(events ?? []), [events]);
  const header = chat.data?.header;
  const summary = useMemo(
    () => (header === undefined ? null : summarize(header, events ?? [])),
    [header, events],
  );
  const personas = useMemo(
    () => (summary?.participants ?? []).map(personaOf),
    [summary, personaOf],
  );
  const next = useMemo(() => nextUp(events ?? []), [events]);
  const chainLimit = useMemo(() => chainLimitOf(events ?? []), [events]);

  if (chat.data === undefined || summary === null) {
    const state =
      chat.error === null
        ? "loading"
        : chat.error instanceof ApiError && chat.error.status === 404
          ? "missing"
          : chat.error;
    return <ChatPlaceholder state={state} onShowList={onShowList} />;
  }

  const { createdAt, participants, title } = summary;
  const [only] = personas;
  const solo = personas.length === 1 && only !== undefined ? only : null;
  const who = chatWith(personas);
  const names = listOf(personas.map((persona) => persona.name));
  const now = Date.now();
  const menuName = chatName(title, who, createdAt, lang, now);
  const retry = turns.busy ? null : retryText(items);
  const placeholder =
    solo === null ? t`Message everyone` : t`Message ${ph({ name: shortNameOf(solo) })}`;

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <ListButton onClick={onShowList} />
        <ParticipantsMenu chatId={id} participants={participants} personaOf={personaOf} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-sm leading-tight">{title ?? who}</h2>
          <p className="truncate text-muted-foreground text-xs">
            {title === null ? shortDate(createdAt, lang, now) : names}
          </p>
        </div>
        {solo !== null && <CallButton persona={solo} />}
        <ChatMenu
          id={id}
          name={menuName}
          onDeleted={onDeleted}
          onSettings={() => setSettingsOpen(true)}
        />
      </header>
      <div className="relative min-h-0 flex-1">
        <ChatLog
          chatId={id}
          personas={personas}
          personaOf={personaOf}
          items={items}
          live={turns.live}
          next={next}
          lateTools={chat.data.lateTools}
          retry={retry}
          onSend={turns.send}
        />
      </div>
      <footer className="flex shrink-0 flex-col gap-3 border-t bg-muted/50 px-4 py-3">
        {turns.live.error !== null && (
          <LiveNotice error={turns.live.error} name={solo === null ? null : shortNameOf(solo)} />
        )}
        <Composer
          placeholder={placeholder}
          participants={personas}
          busy={turns.busy}
          onSend={turns.send}
          onStop={turns.stop}
        />
      </footer>
      <ChatSettingsSheet
        id={id}
        chainLimit={chainLimit}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  );
}
