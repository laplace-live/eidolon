import type { Attachment, ParticipantId } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  CameraIcon,
  CircleAlertIcon,
  HourglassIcon,
  MicIcon,
  PhoneIcon,
  PhoneOffIcon,
  RotateCcwIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react";
import { Fragment, memo, type ReactNode, useEffect, useMemo } from "react";
import { PersonaAvatar } from "@/components/avatar";
import { Photo, Thinking, useStickToBottom } from "@/components/conversation";
import { QuietBadge } from "@/components/quiet-badge";
import { AvatarGroup } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { BotText } from "@/features/call/bot-text";
import { type BotRun, botRuns, userText } from "@/features/call/transcript";
import { chatFilePath } from "@/lib/chats";
import { listOf } from "@/lib/labels";
import { parseMarkup } from "@/lib/markup";
import { cn } from "@/lib/utils";
import { callLine } from "./call-line";
import { type CallRow, callRows, type LiveCall, standsIn } from "./call-live";
import {
  type AudioAttachment,
  type CallItem,
  type ChatItem,
  manyVoices,
  startsRun,
  withoutPartialMarkup,
} from "./items";
import { toolState } from "./labels";
import { type ChatPersona, shortNameOf } from "./persona";
import { type LiveRow, type LiveState, liveRows, type PendingLine, type VoiceClip } from "./stream";
import { type AutoPlayEnd, useObjectUrl, VoiceBubble } from "./voice-bubble";
import { WhyAnswered } from "./why-answered";

const TOOL_ICONS: Readonly<Record<string, ReactNode>> = {
  take_selfie: <CameraIcon />,
  recall_streams: <SearchIcon />,
  voice: <MicIcon />,
};

/** Marks a line said on a call. */
function CallMark() {
  const { t } = useLingui();
  return (
    <>
      <PhoneIcon aria-hidden className="mr-1.5 inline size-3.5 align-[-0.15em] opacity-70" />
      <span className="sr-only">{t`(on the call)`} </span>
    </>
  );
}

function UserBubble({
  text,
  hearing = "",
  call = false,
  failed = false,
  onRetry,
}: {
  readonly text: string;
  /** On a call this page holds, the words still being heard, with their leading space. */
  readonly hearing?: string;
  /** Said on a call. */
  readonly call?: boolean;
  readonly failed?: boolean;
  readonly onRetry?: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-line break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground text-sm",
          failed && "opacity-60",
        )}
      >
        <span className="sr-only">{t({ message: `You`, context: "chat speaker" })}: </span>
        {call && <CallMark />}
        {text}
        {hearing && <span className="italic opacity-70">{hearing}</span>}
      </div>
      {failed && (
        <span className="flex items-center gap-2 text-destructive text-xs">
          {t`Not sent`}
          {onRetry && (
            <Button variant="link" size="xs" className="h-auto p-0" onClick={onRetry}>
              {t`Retry`}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

/** The viewer's voice message, with its transcript; on its way while `transcript` is null. */
function UserVoiceBubble({
  src,
  durationMs,
  transcript,
  failed = false,
  onRetry,
}: {
  readonly src: string | null;
  readonly durationMs: number | null;
  readonly transcript: string | null;
  readonly failed?: boolean;
  readonly onRetry?: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col items-end gap-1">
      <div className={cn("flex max-w-[80%] flex-col items-end", failed && "opacity-60")}>
        <VoiceBubble
          src={src}
          durationMs={durationMs}
          mine
          speaker={t({ message: `You`, context: "chat speaker" })}
          transcript={transcript === null || transcript === "" ? null : transcript}
        />
      </div>
      {transcript === "" && (
        <span className="text-muted-foreground text-xs">{t`No words could be heard in it.`}</span>
      )}
      {transcript === null && !failed && (
        <span role="status" className="animate-pulse text-muted-foreground text-xs">
          {t`Transcribing…`}
        </span>
      )}
      {failed && (
        <span className="flex items-center gap-2 text-destructive text-xs">
          {t`Not sent`}
          {onRetry && (
            <Button variant="link" size="xs" className="h-auto p-0" onClick={onRetry}>
              {t`Retry`}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

/** A voice message of the viewer's that the server hasn't stored yet, played from the recording. */
function PendingVoice({
  line,
  voice,
  onRetry,
}: {
  readonly line: PendingLine;
  readonly voice: VoiceClip;
  readonly onRetry: () => void;
}) {
  const src = useObjectUrl(voice.audio);
  return (
    <UserVoiceBubble
      src={src}
      durationMs={voice.durationMs}
      transcript={null}
      failed={line.failed}
      onRetry={line.failed ? onRetry : undefined}
    />
  );
}

function HerWords({
  name,
  runs,
  call = false,
  aside,
}: {
  readonly name: string;
  readonly runs: readonly BotRun[];
  /** Said on a call. */
  readonly call?: boolean;
  readonly aside?: ReactNode;
}) {
  return (
    <div className="flex max-w-[80%] items-end gap-0.5">
      <div className="min-w-0 whitespace-pre-line break-words rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm">
        <span className="sr-only">{name}: </span>
        {call && <CallMark />}
        <BotText runs={runs} />
      </div>
      {aside}
    </div>
  );
}

function HerPhotos({ name, srcs }: { readonly name: string; readonly srcs: readonly string[] }) {
  const { t } = useLingui();
  const alt = t`A photo from ${name}`;
  const failed = t`This photo couldn't be loaded`;
  return (
    <div className="flex flex-wrap gap-2">
      {srcs.map((src) => (
        <Photo key={src} src={src} alt={alt} failed={failed} />
      ))}
    </div>
  );
}

function HerBubble({
  chatId,
  name,
  text,
  images = [],
  voice = null,
  sentAsText = false,
  interrupted = false,
  cutOff = false,
  call = false,
  onRetry,
  aside,
  autoPlay = false,
  onAutoPlayEnd,
}: {
  readonly chatId: string;
  readonly name: string;
  /** A voice message's transcript. */
  readonly text: string;
  readonly images?: readonly Attachment[];
  readonly voice?: AudioAttachment | null;
  /** Her voice couldn't be made, so her words came as text. */
  readonly sentAsText?: boolean;
  readonly interrupted?: boolean;
  /** Her provider stopped her short. */
  readonly cutOff?: boolean;
  /** Said on a call. */
  readonly call?: boolean;
  readonly onRetry?: (() => void) | null;
  /** Beside her words, or under her photos or voice message. */
  readonly aside?: ReactNode;
  readonly autoPlay?: boolean;
  readonly onAutoPlayEnd?: AutoPlayEnd;
}) {
  const { t } = useLingui();
  const shown = withoutPartialMarkup(text);
  const runs = useMemo<BotRun[]>(
    () => parseMarkup(shown).map((token) => ({ ...token, pending: false })),
    [shown],
  );
  const asideBelow = shown === "" || voice !== null;
  return (
    <div className="flex flex-col items-start gap-1.5">
      {voice !== null && (
        <div className="flex max-w-[80%] flex-col items-start">
          <VoiceBubble
            src={chatFilePath(chatId, voice.name)}
            durationMs={voice.durationMs ?? null}
            mine={false}
            speaker={name}
            transcript={shown === "" ? null : <BotText runs={runs} />}
            autoPlay={autoPlay}
            onAutoPlayEnd={onAutoPlayEnd}
          />
        </div>
      )}
      {voice === null && shown !== "" && (
        <HerWords name={name} runs={runs} call={call} aside={aside} />
      )}
      {images.length > 0 && (
        <HerPhotos name={name} srcs={images.map((image) => chatFilePath(chatId, image.name))} />
      )}
      {(interrupted || cutOff || sentAsText || (asideBelow && aside)) && (
        <div className="flex items-center gap-1">
          {sentAsText && <QuietBadge>{t`Sent as text`}</QuietBadge>}
          {interrupted && <QuietBadge>{t`Interrupted`}</QuietBadge>}
          {cutOff && (
            <span className="flex items-center gap-2">
              <QuietBadge>{t`Cut off`}</QuietBadge>
              {onRetry && (
                <Button variant="link" size="xs" className="h-auto p-0" onClick={onRetry}>
                  {t`Retry`}
                </Button>
              )}
            </span>
          )}
          {asideBelow && aside}
        </div>
      )}
    </div>
  );
}

/** Her line; in a group, under her avatar and short name at the start of a run of hers. */
function Said({
  persona,
  group,
  first,
  children,
}: {
  /** Null while no one is chosen to answer. */
  readonly persona: ChatPersona | null;
  readonly group: boolean;
  readonly first: boolean;
  readonly children: ReactNode;
}) {
  if (!group) return children;
  // In line with the group's lines, past where their avatars go.
  if (persona === null) return <div className="pl-10">{children}</div>;
  return (
    <div className="flex items-start gap-2">
      <div className="w-8 shrink-0">{first && <PersonaAvatar persona={persona} size="sm" />}</div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Her bubble names her to a screen reader. */}
        {first && (
          <span aria-hidden className="truncate text-muted-foreground text-xs">
            {shortNameOf(persona)}
          </span>
        )}
        {children}
      </div>
    </div>
  );
}

function ThinkingLine({
  persona,
  group,
  first,
}: {
  readonly persona: ChatPersona | null;
  readonly group: boolean;
  readonly first: boolean;
}) {
  const { t } = useLingui();
  return (
    <Said persona={persona} group={group} first={first}>
      <Thinking
        label={
          persona === null
            ? t`Waiting for a reply…`
            : t`${ph({ name: shortNameOf(persona) })} is thinking…`
        }
      />
    </Said>
  );
}

function Failed({
  name,
  error,
  onRetry,
}: {
  readonly name: string;
  readonly error: string;
  readonly onRetry: (() => void) | null;
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col items-start gap-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1.5 text-destructive">
          <CircleAlertIcon className="size-4 shrink-0" />
          {t`${name} couldn't answer.`}
        </span>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcwIcon />
            {t`Retry`}
          </Button>
        )}
      </div>
      <p className="max-w-[80%] break-words text-muted-foreground text-xs">{error}</p>
    </div>
  );
}

/** Where a call began or ended: a quiet line across the log. */
function CallSeparator({
  item,
  personaOf,
}: {
  readonly item: CallItem;
  readonly personaOf: (id: ParticipantId) => ChatPersona;
}) {
  const { t } = useLingui();
  const Icon = item.edge === "started" ? PhoneIcon : PhoneOffIcon;
  const name = item.persona === null ? "" : shortNameOf(personaOf(item.persona));
  return (
    <p className="flex items-center gap-3 py-1 text-muted-foreground text-xs">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{t(callLine(item, name))}</span>
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </p>
  );
}

const Item = memo(function Item({
  item,
  chatId,
  personaOf,
  group,
  first,
  onRetry,
  autoPlay,
  onAutoPlayEnd,
}: {
  readonly item: ChatItem;
  readonly chatId: string;
  readonly personaOf: (id: ParticipantId) => ChatPersona;
  readonly group: boolean;
  /** It starts a run of one speaker's lines. */
  readonly first: boolean;
  /** Only the last item's failure, or her reply cut off, offers Retry. */
  readonly onRetry: (() => void) | null;
  /** Her voice message plays on its own now. */
  readonly autoPlay: boolean;
  readonly onAutoPlayEnd: AutoPlayEnd;
}) {
  if (item.kind === "call") return <CallSeparator item={item} personaOf={personaOf} />;
  if (item.kind === "user") {
    return item.voice === null ? (
      <UserBubble text={item.text} call={item.call} />
    ) : (
      <UserVoiceBubble
        src={chatFilePath(chatId, item.voice.name)}
        durationMs={item.voice.durationMs ?? null}
        transcript={item.text}
      />
    );
  }
  const persona = personaOf(item.persona);
  const name = shortNameOf(persona);
  const said =
    item.kind === "failed" ? (
      <Failed name={name} error={item.error} onRetry={onRetry} />
    ) : (
      <HerBubble
        chatId={chatId}
        name={name}
        text={item.text}
        images={item.images}
        voice={item.voice}
        sentAsText={item.sentAsText}
        interrupted={item.interrupted}
        cutOff={item.cutOff !== null}
        call={item.call}
        onRetry={onRetry}
        autoPlay={autoPlay}
        onAutoPlayEnd={onAutoPlayEnd}
        aside={
          item.reason !== null && item.reason.source !== "single" ? (
            <WhyAnswered persona={persona} reason={item.reason} personaOf={personaOf} />
          ) : undefined
        }
      />
    );
  return (
    <Said persona={persona} group={group} first={first}>
      {said}
    </Said>
  );
});

/** What an empty chat shows: who is in it, and how it goes. */
function Intro({ personas }: { readonly personas: readonly ChatPersona[] }) {
  const { t } = useLingui();
  const [only] = personas;
  if (only === undefined) return null;
  const solo = personas.length === 1;
  const name = shortNameOf(only);
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-4 py-8 text-center">
      {solo ? (
        <PersonaAvatar persona={only} size="xl" />
      ) : (
        <AvatarGroup className="-space-x-4 *:data-[slot=avatar]:ring-4 *:data-[slot=avatar]:ring-card">
          {personas.map((persona) => (
            <PersonaAvatar key={persona.id} persona={persona} size="lg" />
          ))}
        </AvatarGroup>
      )}
      <div className="flex flex-col gap-1.5">
        <p className="font-semibold text-xl tracking-tight">
          {listOf(personas.map((persona) => persona.name))}
        </p>
        <p className="text-balance text-muted-foreground text-sm">
          {solo
            ? t`Say something to ${name}, in text or with your voice. This chat keeps what you both said.`
            : t`Say something to everyone here. Whoever it's for answers, and they may answer each other too.`}
        </p>
      </div>
    </div>
  );
}

function ToolLine({ tool }: { readonly tool: string }) {
  const { t } = useLingui();
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 text-muted-foreground text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {TOOL_ICONS[tool] ?? <WrenchIcon />}
      <span className="animate-pulse">{t(toolState(tool))}</span>
    </p>
  );
}

/** A row of the call this page holds, memoized: only the one being said changes. */
const LiveCallRow = memo(function LiveCallRow(
  props: CallRow & {
    readonly personaOf: (id: ParticipantId) => ChatPersona;
    readonly group: boolean;
  },
) {
  if (props.kind === "viewer") {
    const { said, hearing } = userText(props.entry);
    return <UserBubble text={said} hearing={hearing} call />;
  }
  const { entry } = props;
  const persona = props.personaOf(props.persona);
  const name = shortNameOf(persona);
  const runs = entry.kind === "bot" ? botRuns(entry) : [];
  return (
    <Said persona={persona} group={props.group} first={props.first}>
      {runs.length > 0 && <HerWords name={name} runs={runs} call />}
      {entry.kind === "selfie" && <HerPhotos name={name} srcs={entry.paths} />}
    </Said>
  );
});

/**
 * The call this page holds as it is said, below its start, as the call page shows it: the viewer's
 * words as they are heard, hers as she says them, the rest dimmed until she has, her photos, and
 * the wait for her answer.
 */
function LiveCallRows({
  call,
  before,
  next,
  personas,
  personaOf,
  group,
}: {
  readonly call: LiveCall;
  /** The line above its first row. */
  readonly before: ChatItem | undefined;
  /** Who a decision chose to answer next. */
  readonly next: ParticipantId | null;
  readonly personas: readonly ChatPersona[];
  readonly personaOf: (id: ParticipantId) => ChatPersona;
  readonly group: boolean;
}) {
  const { t } = useLingui();
  const rows = callRows(call.transcript, call.persona, before);
  const last = rows.at(-1);
  const thinker = next ?? (call.group ? null : call.persona);
  const everyone = call.group
    ? listOf(personas.map(shortNameOf))
    : shortNameOf(personaOf(call.persona));
  return (
    <>
      {rows.map((row) => (
        // Spread, so memo compares the entries the reducer keeps, not the rows callRows makes anew.
        <LiveCallRow key={row.entry.id} {...row} personaOf={personaOf} group={group} />
      ))}
      {call.group && call.live && rows.length === 0 && (
        <p className="text-balance text-center text-muted-foreground text-xs">
          {t`Everyone can hear you. Say something to start.`}
        </p>
      )}
      {call.wait.thinking && !call.wait.stuck && (
        <ThinkingLine
          persona={thinker === null ? null : personaOf(thinker)}
          group={group}
          first={last === undefined || last.kind === "viewer" || last.persona !== thinker}
        />
      )}
      {call.wait.stuck && (
        <p
          role="status"
          className="flex items-center justify-center gap-1.5 text-center text-muted-foreground text-xs"
        >
          <HourglassIcon className="size-3.5 shrink-0" />
          {t`Still waiting for ${ph({ name: everyone })}. If nothing comes, say it again.`}
        </p>
      )}
    </>
  );
}

/**
 * A chat's lines, then the reply streaming in, kept scrolled to the newest unless the viewer
 * scrolls back. It fills a positioned box.
 */
export function ChatLog({
  chatId,
  personas,
  personaOf,
  items,
  live,
  next,
  lateTools,
  retry,
  autoPlay,
  onAutoPlayEnd,
  inCall,
  call,
  onSend,
  onSendVoice,
}: {
  readonly chatId: string;
  /** Who is in the chat now. */
  readonly personas: readonly ChatPersona[];
  readonly personaOf: (id: ParticipantId) => ChatPersona;
  readonly items: readonly ChatItem[];
  readonly live: LiveState;
  /** The call this page holds, until the chat has stored all of it: shown as it is said. */
  readonly call: LiveCall | null;
  /** Who a decision chose to answer next, before her turn starts. */
  readonly next: ParticipantId | null;
  /** Tools her interrupted turns left running: what they bring lands later. */
  readonly lateTools: readonly string[];
  /** What Retry sends after a failed turn; null offers none. */
  readonly retry: string | null;
  /** The seq of her voice message to play on its own now. */
  readonly autoPlay: number | null;
  readonly onAutoPlayEnd: AutoPlayEnd;
  /** A call is on: its lines arrive as they are said, with no reply to wait for. */
  readonly inCall: boolean;
  readonly onSend: (text: string) => void;
  readonly onSendVoice: (clip: VoiceClip) => void;
}) {
  const { t } = useLingui();
  // Each line names its persona once the chat holds more than one, now or in its lines.
  const group = useMemo(() => personas.length > 1 || manyVoices(items), [personas, items]);
  const { scrollRef, contentRef, pinnedRef, onScroll } = useStickToBottom();
  const { turn, pending } = live;
  const from = call?.from ?? null;
  const shown = useMemo(
    () => (from === null ? items : items.filter((item) => !standsIn(item, from))),
    [items, from],
  );

  // The viewer's own line brings the view back down.
  const sentKey = pending.at(-1)?.key;
  useEffect(() => {
    if (sentKey !== undefined) pinnedRef.current = true;
  }, [sentKey, pinnedRef]);

  // Stable, so the memoized last item doesn't re-render with every streamed delta.
  const retryLast = useMemo(() => (retry === null ? null : () => onSend(retry)), [retry, onSend]);
  const empty = items.length === 0 && turn === null && pending.length === 0;
  const speaker = turn?.persona ?? next ?? (group ? null : (personas[0]?.id ?? null));
  const thinker = speaker === null ? null : personaOf(speaker);
  const last = shown.at(-1);
  // The streaming reply, or the thinking dots, continue her run when she spoke last.
  const continues = last !== undefined && last.kind !== "user" && last.persona === speaker;
  const liveRow = (row: LiveRow): ReactNode => {
    if (row.kind === "streamed") {
      return (
        thinker !== null && (
          <Said persona={thinker} group={group} first={!continues}>
            <HerBubble chatId={chatId} name={shortNameOf(thinker)} text={row.text} />
          </Said>
        )
      );
    }
    if (row.kind === "tool") return <ToolLine tool={row.tool} />;
    if (row.kind === "thinking") {
      return <ThinkingLine persona={thinker} group={group} first={!continues} />;
    }
    const { line } = row;
    const { voice } = line;
    return voice === undefined ? (
      <UserBubble
        text={line.text}
        failed={line.failed}
        onRetry={line.failed ? () => onSend(line.text) : undefined}
      />
    ) : (
      <PendingVoice line={line} voice={voice} onRetry={() => onSendVoice(voice)} />
    );
  };

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label={t`Conversation`}
      onScroll={onScroll}
      className="absolute inset-0 overflow-y-auto px-4 pt-5 pb-6 sm:px-6"
    >
      <div ref={contentRef} className="flex min-h-full flex-col justify-end gap-3">
        {empty && <Intro personas={personas} />}
        {shown.map((item, index) => (
          <Item
            key={item.seq}
            item={item}
            chatId={chatId}
            personaOf={personaOf}
            group={group}
            first={startsRun(shown, index)}
            onRetry={index === shown.length - 1 ? retryLast : null}
            autoPlay={item.seq === autoPlay}
            onAutoPlayEnd={onAutoPlayEnd}
          />
        ))}
        {call !== null && (
          <LiveCallRows
            call={call}
            before={last}
            next={next}
            personas={personas}
            personaOf={personaOf}
            group={group}
          />
        )}
        {[...new Set(lateTools)].map((tool) => (
          <ToolLine key={tool} tool={tool} />
        ))}
        {liveRows(live, inCall).map((row) => (
          <Fragment key={row.kind === "pending" ? row.line.key : row.kind}>{liveRow(row)}</Fragment>
        ))}
      </div>
    </div>
  );
}
