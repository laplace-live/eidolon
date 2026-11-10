import type { Attachment } from "@eidolon/chat";
import { useLingui } from "@lingui/react/macro";
import { CameraIcon, CircleAlertIcon, RotateCcwIcon, SearchIcon, WrenchIcon } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo } from "react";
import { PersonaAvatar } from "@/components/avatar";
import { Photo, Thinking, useStickToBottom } from "@/components/conversation";
import { QuietBadge } from "@/components/quiet-badge";
import { Button } from "@/components/ui/button";
import { BotText } from "@/features/call/bot-text";
import type { BotRun } from "@/features/call/transcript";
import { chatFilePath } from "@/lib/chats";
import { parseMarkup } from "@/lib/markup";
import { cn } from "@/lib/utils";
import { type ChatItem, withoutPartialMarkup } from "./items";
import { toolState } from "./labels";
import { type ChatPersona, shortNameOf } from "./persona";
import type { LiveState } from "./stream";

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
}: {
  readonly chatId: string;
  readonly name: string;
  readonly text: string;
  readonly images?: readonly Attachment[];
  readonly interrupted?: boolean;
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
        <div className="max-w-[80%] whitespace-pre-line break-words rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm">
          <span className="sr-only">{name}: </span>
          <BotText runs={runs} />
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
      {interrupted && <QuietBadge>{t`Interrupted`}</QuietBadge>}
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
  name,
  onRetry,
}: {
  readonly item: ChatItem;
  readonly chatId: string;
  readonly name: string;
  /** Only the last item's failure offers Retry. */
  readonly onRetry: (() => void) | null;
}) {
  if (item.kind === "user") return <UserBubble text={item.text} />;
  if (item.kind === "failed") return <Failed name={name} error={item.error} onRetry={onRetry} />;
  return (
    <HerBubble
      chatId={chatId}
      name={name}
      text={item.text}
      images={item.images}
      interrupted={item.interrupted}
    />
  );
});

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
  persona,
  items,
  live,
  lateTools,
  retry,
  onSend,
}: {
  readonly chatId: string;
  readonly persona: ChatPersona;
  readonly items: readonly ChatItem[];
  readonly live: LiveState;
  /** Tools her interrupted turns left running: what they bring lands later. */
  readonly lateTools: readonly string[];
  /** What Retry sends after a failed turn; null offers none. */
  readonly retry: string | null;
  readonly onSend: (text: string) => void;
}) {
  const { t } = useLingui();
  const name = shortNameOf(persona);
  const { scrollRef, contentRef, pinnedRef, onScroll } = useStickToBottom();
  const { turn, pending } = live;

  // The viewer's own line brings the view back down.
  const sentKey = pending?.key;
  useEffect(() => {
    if (sentKey !== undefined) pinnedRef.current = true;
  }, [sentKey, pinnedRef]);

  const retryLast = retry === null ? null : () => onSend(retry);
  const streamed = turn === null ? "" : withoutPartialMarkup(turn.text);
  const waiting = pending !== null && !pending.failed && turn === null;
  const thinking = waiting || (turn !== null && streamed === "" && turn.tool === null);
  const empty = items.length === 0 && turn === null && pending === null;

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-label={t`Conversation`}
      onScroll={onScroll}
      className="absolute inset-0 overflow-y-auto px-4 pt-5 pb-6 sm:px-6"
    >
      <div ref={contentRef} className="flex min-h-full flex-col justify-end gap-3">
        {empty && (
          <div className="m-auto flex max-w-sm flex-col items-center gap-4 py-8 text-center">
            <PersonaAvatar persona={persona} size="xl" />
            <div className="flex flex-col gap-1.5">
              <p className="font-semibold text-xl tracking-tight">{persona.name}</p>
              <p className="text-balance text-muted-foreground text-sm">
                {t`Say something to ${name}. She answers in text, and this chat keeps what you both said.`}
              </p>
            </div>
          </div>
        )}
        {items.map((item, index) => (
          <Item
            key={item.seq}
            item={item}
            chatId={chatId}
            name={name}
            onRetry={index === items.length - 1 ? retryLast : null}
          />
        ))}
        {[...new Set(lateTools)].map((tool) => (
          <ToolLine key={tool} tool={tool} />
        ))}
        {streamed !== "" && <HerBubble chatId={chatId} name={name} text={streamed} />}
        {turn !== null && turn.tool !== null && <ToolLine tool={turn.tool} />}
        {pending !== null && (
          <UserBubble
            text={pending.text}
            failed={pending.failed}
            onRetry={pending.failed ? () => onSend(pending.text) : undefined}
          />
        )}
        {thinking && <Thinking label={t`${name} is thinking…`} />}
      </div>
    </div>
  );
}
