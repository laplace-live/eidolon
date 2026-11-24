import {
  type ChatDisplay,
  type ChatEvent,
  chainLimitOf,
  displayOf,
  type ParticipantId,
  permissionsOf,
  replyModeOf,
  summarize,
} from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, MessageSquareOffIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { MobileBar } from "@/components/mobile-bar";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useCallPresence, useShellCall } from "@/features/call/call-context";
import { MicPill } from "@/features/call/call-controls";
import { chatCallView, chatTarget, hostOf } from "@/features/call/target";
import { VideoCall } from "@/features/call/video-call";
import { nameableSkills, skillsQuery } from "@/features/settings/skills";
import { chatTasksQuery } from "@/features/tasks/queries";
import { stopChoice } from "@/features/tasks/state";
import { StopPicker } from "@/features/tasks/stop-picker";
import { useChatTasks } from "@/features/tasks/use-chat-tasks";
import { WaitingBar } from "@/features/tasks/waiting-bar";
import { ApiError, type ErrorCode, type TaskSnapshot } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { listOf } from "@/lib/labels";
import { statusQuery } from "@/lib/query";
import { useLang } from "@/locales/i18n";
import { DropFiles } from "./attachments";
import { CallButton, CallDock } from "./call-dock";
import { type LiveCall, ongoingCall } from "./call-live";
import { ChatLog } from "./chat-log";
import { ChatMenu } from "./chat-menu";
import { ChatSettingsSheet } from "./chat-settings";
import type { ChatCommand } from "./commands";
import { Composer } from "./composer";
import { chatName, shortDate } from "./format";
import { nextUp } from "./group";
import { chatItems, displayedItems, retryLine } from "./items";
import { DISPLAY_CHANGED, DISPLAY_HELP } from "./labels";
import { ParticipantsMenu } from "./participants";
import { PermissionsPicker } from "./permissions-picker";
import { chatWith, shortNameOf, usePersonaOf } from "./persona";
import { chatQuery, useSetDisplay } from "./queries";
import { callOn, type LiveError } from "./stream";
import { useChat } from "./use-chat";
import { useDraftFiles } from "./use-draft-files";
import { canRecord } from "./use-recorder";
import type { MicState } from "./voice-recorder";

const NO_EVENTS: readonly ChatEvent[] = [];
const NO_TASKS: ReadonlySet<string> = new Set();

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

/** The pane while there is no chat to show: loading, gone, or failed. */
export function ChatPlaceholder({ state }: { readonly state: "loading" | "missing" | Error }) {
  const { t } = useLingui();
  return (
    <>
      <MobileBar />
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

export function ChatView({ id }: { readonly id: string }) {
  const { t } = useLingui();
  const lang = useLang();
  const queryClient = useQueryClient();
  const chat = useQuery(chatQuery(id));
  const { data: status } = useQuery(statusQuery);
  const personaOf = usePersonaOf();
  // The server's word on a call in the chat, which another tab may hold.
  const serverCall = useMemo(
    () => (chat.data === undefined ? null : callOn(chat.data)),
    [chat.data],
  );
  const presence = useCallPresence();
  const { target, setLayout } = presence;
  const view = chatCallView(presence, id);
  // This tab knows of its own call before the server's answer says so.
  const inCall = view.calling || serverCall !== null;
  const events = chat.data?.events;
  const tasks = useChatTasks(id, events ?? NO_EVENTS);
  // Another tab's call is followed too, so its lines show and its end frees the composer.
  const turns = useChat(id, inCall, tasks.awaitingReport);
  const draftFiles = useDraftFiles(id);
  const [recordable] = useState(canRecord);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ownDisplay = useMemo(() => displayOf(events ?? []), [events]);
  const display: ChatDisplay | null =
    chat.data === undefined ? null : (ownDisplay ?? chat.data.defaultDisplay);
  const setDisplay = useSetDisplay();
  const ownPermissions = useMemo(() => permissionsOf(events ?? []), [events]);
  const [stopping, setStopping] = useState<{
    readonly open: boolean;
    readonly tasks: readonly TaskSnapshot[];
  }>({ open: false, tasks: [] });
  // The task card to bring into view: the Tasks list links here with ?task=, and the waiting bar
  // shows its own. Focus shows a card brought into view until the display changes.
  const [params, setParams] = useSearchParams();
  const linked = params.get("task");
  const [focus, setFocus] = useState<string | null>(linked);
  const [revealed, setRevealed] = useState({ display, tasks: NO_TASKS });
  if (revealed.display !== display) setRevealed({ display, tasks: NO_TASKS });
  useEffect(() => {
    if (linked !== null) setFocus(linked);
  }, [linked]);
  const focused = useCallback(
    (task: string) => {
      setFocus(null);
      setRevealed((current) => ({ ...current, tasks: new Set([...current.tasks, task]) }));
      if (linked === null) return;
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("task");
          return next;
        },
        { replace: true },
      );
    },
    [linked, setParams],
  );
  const items = useMemo(() => chatItems(events ?? []), [events]);
  // Every item, the cards focus hides included: a task her failed turn started holds Retry back.
  // Kept while the items are, so the log's memoized last item doesn't render again.
  const retryable = useMemo(() => retryLine(items), [items]);
  // Focus would hide the card on its way into view, and the log could never scroll to it.
  const visible = useMemo(
    () => (focus === null ? revealed.tasks : new Set([...revealed.tasks, focus])),
    [focus, revealed.tasks],
  );
  const shownItems = useMemo(
    () => displayedItems(items, display, visible),
    [items, display, visible],
  );
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
  // The tab's call in this chat shows as it is said, until the log has all of it.
  const held = view.mine ? presence.serverCall : null;
  const callFrom = useMemo(
    () => (held === null ? null : ongoingCall(events ?? [], held)),
    [events, held],
  );
  const chainLimit = useMemo(() => chainLimitOf(events ?? []), [events]);
  const replyMode = useMemo(() => replyModeOf(events ?? []), [events]);
  // She is asked for a skill by name only in a chat of hers alone, while her tasks can start.
  const assistant = status?.assistant;
  const named = personas.length === 1 && assistant?.enabled === true && assistant.ready;
  const nameable = useQuery({ ...skillsQuery, select: nameableSkills, enabled: named });
  // A disabled query still answers from the cache that Settings fills.
  const skills = named ? (nameable.data ?? []) : [];

  // A task to show docks the call: the log under the screen takes no focus, so its card can't.
  useEffect(() => {
    if (focus !== null && view.video) setLayout("dock");
  }, [focus, view.video, setLayout]);

  if (chat.data === undefined || summary === null) {
    const state =
      chat.error === null
        ? "loading"
        : chat.error instanceof ApiError && chat.error.status === 404
          ? "missing"
          : chat.error;
    return <ChatPlaceholder state={state} />;
  }

  const { createdAt, participants, title } = summary;
  const [only] = personas;
  const solo = personas.length === 1 && only !== undefined ? only : null;
  const who = chatWith(personas);
  const names = listOf(personas.map((persona) => persona.name));
  const now = Date.now();
  const menuName = chatName(title, who, createdAt, lang, now);
  const retry = turns.busy || inCall ? null : retryable;
  const placeholder =
    solo === null ? t`Message everyone` : t`Message ${ph({ name: shortNameOf(solo) })}`;
  const mic: MicState = !recordable
    ? "unsupported"
    : chat.data.hearingRefusal !== null
      ? "no-key"
      : "ready";
  const placeCall = (persona: ParticipantId, group: boolean) =>
    presence.start(chatTarget(id, personaOf(persona), group ? personas : null));
  const liveCall: LiveCall | null =
    callFrom === null || target?.kind !== "chat"
      ? null
      : { from: callFrom, persona: hostOf(target).id, group: target.group };
  const waiting =
    tasks.bar === null ? undefined : (
      <WaitingBar
        task={tasks.bar.task}
        others={tasks.bar.others}
        onShow={() => setFocus(tasks.bar?.task.id ?? null)}
      />
    );

  // Read afresh: the chat's list polls only every few seconds, and only once her log holds a task.
  const askStop = async () => {
    const read = await queryClient
      .fetchQuery({ ...chatTasksQuery(id), staleTime: 0 })
      .catch((error: unknown) => {
        toastError(error);
        return null;
      });
    if (read === null) return;
    const live = stopChoice(read.tasks);
    if (live.length === 0) {
      toast.info(t`Nothing to stop`, {
        description: t`No task in this chat is running or waiting for you.`,
      });
      return;
    }
    setStopping({ open: true, tasks: live });
  };
  const runCommand = (command: ChatCommand) => {
    if (command === "stop") {
      void askStop();
      return;
    }
    const told = () =>
      toast.success(t(DISPLAY_CHANGED[command]), { description: t(DISPLAY_HELP[command]) });
    if (ownDisplay === command) told();
    else setDisplay.mutate({ id, display: command }, { onSuccess: told });
  };

  return (
    <>
      <header data-window-drag className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <SidebarTrigger className="-ml-1.5 md:hidden" />
        <ParticipantsMenu chatId={id} participants={participants} personaOf={personaOf} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-sm leading-tight">{title ?? who}</h2>
          <p className="truncate text-muted-foreground text-xs">
            {title === null ? shortDate(createdAt, lang, now) : names}
          </p>
        </div>
        <CallButton
          personas={personas}
          groupCall={chat.data.groupCall}
          disabled={inCall}
          unavailable={view.elsewhere ? t`You're already in a call. Hang up first.` : null}
          onCall={placeCall}
        />
        <ChatMenu id={id} name={menuName} onSettings={() => setSettingsOpen(true)} />
      </header>
      <div className="relative min-h-0 flex-1">
        <ChatLog
          chatId={id}
          display={display}
          personas={personas}
          personaOf={personaOf}
          items={shownItems}
          live={turns.live}
          next={next}
          lateTools={chat.data.lateTools}
          retry={retry}
          autoPlay={turns.autoPlay}
          onAutoPlayEnd={turns.autoPlayEnded}
          inCall={inCall}
          call={liveCall}
          onSend={turns.send}
          onSendVoice={turns.sendVoice}
          focusTask={view.video ? null : focus}
          onFocused={focused}
          inert={view.video}
          footer={
            <>
              {view.docked && <DockPill />}
              {!view.video && waiting}
              {view.docked && (
                <CallDock
                  status={status}
                  onCallAgain={() => {
                    if (target?.kind === "chat") placeCall(hostOf(target).id, target.group);
                  }}
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
                skills={skills}
                busy={turns.busy}
                mic={mic}
                inCall={inCall}
                files={draftFiles}
                leading={
                  // Only a chat of hers alone starts tasks.
                  status?.assistant.enabled &&
                  solo !== null && (
                    <PermissionsPicker
                      id={id}
                      own={ownPermissions}
                      fallback={chat.data.defaultPermissions}
                    />
                  )
                }
                onSend={turns.send}
                onSendVoice={turns.sendVoice}
                onStop={turns.stop}
                onCommand={runCommand}
              />
            </>
          }
        />
        <DropFiles disabled={inCall} onFiles={draftFiles.add} />
        {view.video && (
          <VideoCall
            className="absolute inset-0 z-10"
            status={status}
            titled
            waiting={waiting}
            onShrink={() => setLayout("dock")}
          />
        )}
      </div>
      <ChatSettingsSheet
        id={id}
        chainLimit={chainLimit}
        replyMode={replyMode}
        display={ownDisplay}
        defaultDisplay={chat.data.defaultDisplay}
        permissions={ownPermissions}
        defaultPermissions={chat.data.defaultPermissions}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <StopPicker
        chatId={id}
        open={stopping.open}
        tasks={stopping.tasks}
        onOpenChange={(open) => setStopping((current) => ({ ...current, open }))}
      />
    </>
  );
}

/** The mic's pill over the dock: it, not the page, renders again with each of the call's events. */
function DockPill() {
  return <MicPill call={useShellCall()} className="bottom-full mb-2" />;
}
