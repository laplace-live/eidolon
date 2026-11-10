import { chainLimitOf, type ParticipantId, replyModeOf, summarize } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { KeyRoundIcon, MessageSquareOffIcon, PanelLeftIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { MicPill } from "@/features/call/call-controls";
import { useCall } from "@/features/call/use-call";
import { ApiError, type ErrorCode } from "@/lib/api";
import { listOf } from "@/lib/labels";
import { statusQuery } from "@/lib/query";
import { useLang } from "@/locales/i18n";
import { CallButton, CallDock } from "./call-dock";
import { ChatLog } from "./chat-log";
import { ChatMenu } from "./chat-menu";
import { ChatSettingsSheet } from "./chat-settings";
import { Composer } from "./composer";
import { chatName, shortDate } from "./format";
import { nextUp } from "./group";
import { chatItems, retryText } from "./items";
import { ParticipantsMenu } from "./participants";
import { chatWith, shortNameOf, usePersonaOf } from "./persona";
import { chatQuery } from "./queries";
import { callOn, type LiveError } from "./stream";
import { useChat } from "./use-chat";
import { canRecord } from "./use-recorder";
import type { MicState } from "./voice-recorder";

/** A reply that couldn't start: a key she needs, else the API's failure. */
function LiveNotice({
  error,
  name,
  unheard,
}: {
  readonly error: LiveError;
  /** Hers in a chat with one persona; null in a group, where the message names who. */
  readonly name: string | null;
  /** The chat can't hear a voice message, so a voice message's refusal was for that key. */
  readonly unheard: boolean;
}) {
  const { t } = useLingui();
  if (error.code === "missing-key") {
    const title =
      error.voice && unheard
        ? name === null
          ? t`Voice messages can't be heard yet`
          : t`${ph({ name })} can't hear voice messages yet`
        : name === null
          ? t`Someone here can't answer yet`
          : t`${ph({ name })} can't answer yet`;
    return (
      <Alert>
        <KeyRoundIcon />
        <AlertTitle>{title}</AlertTitle>
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
  const { data: status, refetch: refetchStatus } = useQuery(statusQuery);
  const personaOf = usePersonaOf();
  const call = useCall();
  // Whom the docked call is with: set by Call, and cleared by closing the dock.
  const [callee, setCallee] = useState<ParticipantId | null>(null);
  const { phase } = call;
  const calling = phase.name !== "idle" && phase.name !== "ended";
  const turns = useChat(id, calling);
  const [recordable] = useState(canRecord);
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
  const replyMode = useMemo(() => replyModeOf(events ?? []), [events]);
  // The server's word on a call in the chat, which another tab may hold.
  const serverCall = useMemo(
    () => (chat.data === undefined ? null : callOn(chat.data)),
    [chat.data],
  );

  // Status then says whether the bot recorded a failure.
  const ended = phase.name === "ended";
  useEffect(() => {
    if (ended) void refetchStatus();
  }, [ended, refetchStatus]);

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
  // This page knows of its own call before the server's answer says so.
  const inCall = calling || serverCall !== null;
  const retry = turns.busy || inCall ? null : retryText(items);
  const placeholder =
    solo === null ? t`Message everyone` : t`Message ${ph({ name: shortNameOf(solo) })}`;
  const mic: MicState = !recordable
    ? "unsupported"
    : chat.data.hearingRefusal !== null
      ? "no-key"
      : "ready";
  // Hanging up returns to the composer; a call that ended any other way stays to say why.
  const docked =
    callee !== null &&
    phase.name !== "idle" &&
    !(phase.name === "ended" && phase.end.kind === "hung-up");
  const startCall = (persona: ParticipantId) => {
    setCallee(persona);
    call.start({ chatId: id, persona });
  };

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
        <CallButton personas={personas} disabled={inCall} onCall={startCall} />
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
          autoPlay={turns.autoPlay}
          onAutoPlayEnd={turns.autoPlayEnded}
          inCall={inCall}
          onSend={turns.send}
          onSendVoice={turns.sendVoice}
        />
        <MicPill call={call} />
      </div>
      <footer className="flex shrink-0 flex-col gap-3 border-t bg-muted/50 px-4 py-3">
        {docked && (
          <CallDock
            call={call}
            persona={personaOf(callee)}
            status={status}
            onCallAgain={() => startCall(callee)}
            onClose={() => setCallee(null)}
          />
        )}
        {turns.live.error !== null && (
          <LiveNotice
            error={turns.live.error}
            name={solo === null ? null : shortNameOf(solo)}
            unheard={chat.data.hearingRefusal !== null}
          />
        )}
        <Composer
          placeholder={placeholder}
          participants={personas}
          busy={turns.busy}
          mic={mic}
          inCall={inCall}
          onSend={turns.send}
          onSendVoice={turns.sendVoice}
          onStop={turns.stop}
        />
      </footer>
      <ChatSettingsSheet
        id={id}
        chainLimit={chainLimit}
        replyMode={replyMode}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      {/* biome-ignore lint/a11y/useMediaCaption: a live MediaStream takes no track; the chat's log is its caption. */}
      <audio ref={call.audioRef} autoPlay hidden />
    </>
  );
}
