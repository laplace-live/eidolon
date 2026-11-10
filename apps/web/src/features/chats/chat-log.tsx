import type { Attachment, ParticipantId } from "@eidolon/chat";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CameraIcon, CircleAlertIcon, RotateCcwIcon, SearchIcon, WrenchIcon } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo } from "react";
import { PersonaAvatar } from "@/components/avatar";
import { Photo, Thinking, useStickToBottom } from "@/components/conversation";
import { QuietBadge } from "@/components/quiet-badge";
import { AvatarGroup } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { BotText } from "@/features/call/bot-text";
import type { BotRun } from "@/features/call/transcript";
import { chatFilePath } from "@/lib/chats";
import { listOf } from "@/lib/labels";
import { parseMarkup } from "@/lib/markup";
import { cn } from "@/lib/utils";
import { type ChatItem, manyVoices, startsRun, withoutPartialMarkup } from "./items";
import { toolState } from "./labels";
import { type ChatPersona, shortNameOf } from "./persona";
import type { LiveState } from "./stream";
import { WhyAnswered } from "./why-answered";

const TOOL_ICONS: Readonly<Record<string, ReactNode>> = {
  take_selfie: <CameraIcon />,
  recall_streams: <SearchIcon />,
};

function UserBubble({
  text,
  failed = false,
  onRetry,
}: {
  readonly text: string;
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
        {text}
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

function HerBubble({
  chatId,
  name,
  text,
  images = [],
  interrupted = false,
  aside,
}: {
  readonly chatId: string;
  readonly name: string;
  readonly text: string;
  readonly images?: readonly Attachment[];
  readonly interrupted?: boolean;
  /** Beside her words, or under her photos when she sent no words. */
  readonly aside?: ReactNode;
}) {
  const { t } = useLingui();
  const shown = withoutPartialMarkup(text);
  const runs = useMemo<BotRun[]>(
    () => parseMarkup(shown).map((token) => ({ ...token, pending: false })),
    [shown],
  );
  const alt = t`A photo from ${name}`;
  const failed = t`This photo couldn't be loaded`;
  return (
    <div className="flex flex-col items-start gap-1.5">
      {shown !== "" && (
        <div className="flex max-w-[80%] items-end gap-0.5">
          <div className="min-w-0 whitespace-pre-line break-words rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm">
            <span className="sr-only">{name}: </span>
            <BotText runs={runs} />
          </div>
          {aside}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((image) => (
            <Photo
              key={image.name}
              src={chatFilePath(chatId, image.name)}
              alt={alt}
              failed={failed}
            />
          ))}
        </div>
      )}
      {(interrupted || (shown === "" && aside)) && (
        <div className="flex items-center gap-1">
          {interrupted && <QuietBadge>{t`Interrupted`}</QuietBadge>}
          {shown === "" && aside}
        </div>
      )}
    </div>
  );
}

/** A group's line from her: her avatar and short name at the start of a run of hers. */
function Said({
  persona,
  first,
  children,
}: {
  readonly persona: ChatPersona;
  readonly first: boolean;
  readonly children: ReactNode;
}) {
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

const Item = memo(function Item({
  item,
  chatId,
  personaOf,
  group,
  first,
  onRetry,
}: {
  readonly item: ChatItem;
  readonly chatId: string;
  readonly personaOf: (id: ParticipantId) => ChatPersona;
  readonly group: boolean;
  /** It starts a run of one speaker's lines. */
  readonly first: boolean;
  /** Only the last item's failure offers Retry. */
  readonly onRetry: (() => void) | null;
}) {
  if (item.kind === "user") return <UserBubble text={item.text} />;
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
        interrupted={item.interrupted}
        aside={
          item.reason !== null && item.reason.source !== "single" ? (
            <WhyAnswered persona={persona} reason={item.reason} personaOf={personaOf} />
          ) : undefined
        }
      />
    );
  return group ? (
    <Said persona={persona} first={first}>
      {said}
    </Said>
  ) : (
    said
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
            ? t`Say something to ${name}. She answers in text, and this chat keeps what you both said.`
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
  onSend,
}: {
  readonly chatId: string;
  /** Who is in the chat now. */
  readonly personas: readonly ChatPersona[];
  readonly personaOf: (id: ParticipantId) => ChatPersona;
  readonly items: readonly ChatItem[];
  readonly live: LiveState;
  /** Who a decision chose to answer next, before her turn starts. */
  readonly next: ParticipantId | null;
  /** Tools her interrupted turns left running: what they bring lands later. */
  readonly lateTools: readonly string[];
  /** What Retry sends after a failed turn; null offers none. */
  readonly retry: string | null;
  readonly onSend: (text: string) => void;
}) {
  const { t } = useLingui();
  // Each line names its persona once the chat holds more than one, now or in its lines.
  const group = useMemo(() => personas.length > 1 || manyVoices(items), [personas, items]);
  const { scrollRef, contentRef, pinnedRef, onScroll } = useStickToBottom();
  const { turn, pending } = live;

  // The viewer's own line brings the view back down.
  const sentKey = pending?.key;
  useEffect(() => {
    if (sentKey !== undefined) pinnedRef.current = true;
  }, [sentKey, pinnedRef]);

  const retryLast = retry === null ? null : () => onSend(retry);
  const streamed = turn === null ? "" : withoutPartialMarkup(turn.text);
  // A group's reply goes on between turns, while the director decides who answers next.
  const waiting = (pending !== null && !pending.failed) || live.following > 0;
  const thinking = turn === null ? waiting : streamed === "" && turn.tool === null;
  const empty = items.length === 0 && turn === null && pending === null;
  const speaker = turn?.persona ?? next ?? (group ? null : (personas[0]?.id ?? null));
  const thinker = speaker === null ? null : personaOf(speaker);
  const last = items.at(-1);
  // The streaming reply, or the thinking dots, continue her run when she spoke last.
  const continues = last !== undefined && last.kind !== "user" && last.persona === speaker;
  const said = (children: ReactNode) =>
    !group ? (
      children
    ) : thinker === null ? (
      // In line with the group's lines, past where their avatars go.
      <div className="pl-10">{children}</div>
    ) : (
      <Said persona={thinker} first={!continues}>
        {children}
      </Said>
    );

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
        {items.map((item, index) => (
          <Item
            key={item.seq}
            item={item}
            chatId={chatId}
            personaOf={personaOf}
            group={group}
            first={startsRun(items, index)}
            onRetry={index === items.length - 1 ? retryLast : null}
          />
        ))}
        {[...new Set(lateTools)].map((tool) => (
          <ToolLine key={tool} tool={tool} />
        ))}
        {streamed !== "" &&
          thinker !== null &&
          said(<HerBubble chatId={chatId} name={shortNameOf(thinker)} text={streamed} />)}
        {turn !== null && turn.tool !== null && <ToolLine tool={turn.tool} />}
        {pending !== null && (
          <UserBubble
            text={pending.text}
            failed={pending.failed}
            onRetry={pending.failed ? () => onSend(pending.text) : undefined}
          />
        )}
        {thinking &&
          said(
            <Thinking
              label={
                thinker === null
                  ? t`Waiting for a reply…`
                  : t`${ph({ name: shortNameOf(thinker) })} is thinking…`
              }
            />,
          )}
      </div>
    </div>
  );
}
