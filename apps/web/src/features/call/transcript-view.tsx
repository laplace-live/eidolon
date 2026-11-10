import { useLingui } from "@lingui/react/macro";
import { HourglassIcon } from "lucide-react";
import { memo, type ReactNode, useMemo } from "react";
import { Photo, Thinking, useStickToBottom } from "@/components/conversation";
import { cn } from "@/lib/utils";
import { BotText } from "./bot-text";
import {
  type BotEntry,
  botRuns,
  type Entry,
  type Transcript,
  type UserEntry,
  userText,
} from "./transcript";
import type { WaitState } from "./watchdog";

function UserBubble({ entry }: { readonly entry: UserEntry }) {
  const { t } = useLingui();
  const { said, hearing } = userText(entry);
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-line rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground text-sm",
          entry.failed && "opacity-60",
        )}
      >
        <span className="sr-only">
          {t({ message: `You`, context: "call transcript speaker" })}:{" "}
        </span>
        {said}
        {hearing && <span className="italic opacity-70">{hearing}</span>}
      </div>
      {entry.failed && <span className="text-destructive text-xs">{t`Not sent`}</span>}
    </div>
  );
}

/** Her reply; on a group call, under the name of whoever said it. */
function BotBubble({ entry, name }: { readonly entry: BotEntry; readonly name: string }) {
  const runs = useMemo(() => botRuns(entry), [entry]);
  const speaker = entry.speaker?.name ?? null;
  return (
    <div className="flex flex-col items-start gap-1">
      {/* Her bubble names her to a screen reader. */}
      {speaker !== null && (
        <span aria-hidden className="max-w-[80%] truncate text-muted-foreground text-xs">
          {speaker}
        </span>
      )}
      <div className="max-w-[80%] whitespace-pre-line rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm">
        <span className="sr-only">{speaker ?? name}: </span>
        <BotText runs={runs} />
      </div>
    </div>
  );
}

const EntryView = memo(function EntryView({
  entry,
  name,
}: {
  readonly entry: Entry;
  readonly name: string;
}) {
  const { t } = useLingui();
  if (entry.kind === "user") return <UserBubble entry={entry} />;
  if (entry.kind === "bot") return <BotBubble entry={entry} name={name} />;
  const alt = t`A selfie from ${name}`;
  // The bot keeps a selfie for 10 minutes, after which it 404s.
  const expired = t`This photo has expired`;
  return (
    <div className="flex flex-wrap gap-2">
      {entry.paths.map((path) => (
        <Photo key={path} src={path} alt={alt} failed={expired} />
      ))}
    </div>
  );
});

/**
 * The call's transcript, kept scrolled to the newest line unless the viewer scrolls back. It fills
 * a positioned box; `intro` shows over it until the first line.
 */
export function TranscriptView({
  transcript,
  wait,
  name,
  intro,
}: {
  readonly transcript: Transcript;
  readonly wait: WaitState;
  /** The persona's short name. */
  readonly name: string;
  /** Kept out of the log, which holds only the conversation's lines. */
  readonly intro: ReactNode;
}) {
  const { t } = useLingui();
  const { scrollRef, contentRef, onScroll } = useStickToBottom();
  const empty = transcript.entries.length === 0 && !wait.thinking && !wait.stuck;
  return (
    <>
      <div
        ref={scrollRef}
        role="log"
        aria-label={t`Conversation`}
        onScroll={onScroll}
        className="absolute inset-0 overflow-y-auto px-4 pt-5 pb-12 sm:px-6"
      >
        <div ref={contentRef} className="flex min-h-full flex-col justify-end gap-3">
          {transcript.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} name={name} />
          ))}
          {wait.thinking && !wait.stuck && <Thinking label={t`${name} is thinking…`} />}
          {wait.stuck && (
            <p
              role="status"
              className="flex items-center justify-center gap-1.5 text-center text-muted-foreground text-xs"
            >
              <HourglassIcon className="size-3.5 shrink-0" />
              {t`Still waiting for ${name}. If nothing comes, say it again.`}
            </p>
          )}
        </div>
      </div>
      {empty && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          {intro}
        </div>
      )}
    </>
  );
}
