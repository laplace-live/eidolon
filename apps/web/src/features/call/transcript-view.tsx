import { HourglassIcon } from "lucide-react";
import { memo, type ReactNode, useEffect, useMemo, useRef } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { BotText } from "./bot-text";
import { SelfieImage } from "./selfie-image";
import {
  type BotEntry,
  botRuns,
  type Entry,
  type Transcript,
  type UserEntry,
  userText,
} from "./transcript";
import type { WaitState } from "./watchdog";

/** Within this many pixels of the bottom, new lines keep the view scrolled down. */
const PINNED_SLACK_PX = 48;

function UserBubble({ entry }: { readonly entry: UserEntry }) {
  const t = useT();
  const { said, hearing } = userText(entry);
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-line rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground text-sm",
          entry.failed && "opacity-60",
        )}
      >
        <span className="sr-only">{t("call.you")}: </span>
        {said}
        {hearing && <span className="italic opacity-70">{hearing}</span>}
      </div>
      {entry.failed && <span className="text-destructive text-xs">{t("call.input.failed")}</span>}
    </div>
  );
}

function BotBubble({ entry, name }: { readonly entry: BotEntry; readonly name: string }) {
  const runs = useMemo(() => botRuns(entry), [entry]);
  return (
    <div className="flex">
      <div className="max-w-[80%] whitespace-pre-line rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-sm">
        <span className="sr-only">{name}: </span>
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
  const t = useT();
  if (entry.kind === "user") return <UserBubble entry={entry} />;
  if (entry.kind === "bot") return <BotBubble entry={entry} name={name} />;
  const alt = t("call.selfie.alt", { name });
  return (
    <div className="flex flex-wrap gap-2">
      {entry.paths.map((path) => (
        <SelfieImage key={path} path={path} alt={alt} />
      ))}
    </div>
  );
});

function Thinking({ label }: { readonly label: string }) {
  return (
    <div className="flex">
      <div
        role="status"
        className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-muted px-3.5 py-3"
      >
        <span className="sr-only">{label}</span>
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:0.2s]" />
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground [animation-delay:0.4s]" />
      </div>
    </div>
  );
}

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
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastTopRef = useRef(0);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const empty = transcript.entries.length === 0 && !wait.thinking && !wait.stuck;
  return (
    <>
      <div
        ref={scrollRef}
        role="log"
        aria-label={t("call.transcript.label")}
        onScroll={(event) => {
          // Only scrolling up lets go: the event for a scroll to the bottom can arrive after more
          // lines did, and would read as the viewer leaving the bottom.
          const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
          if (scrollHeight - scrollTop - clientHeight < PINNED_SLACK_PX) pinnedRef.current = true;
          else if (scrollTop < lastTopRef.current) pinnedRef.current = false;
          lastTopRef.current = scrollTop;
        }}
        className="absolute inset-0 overflow-y-auto px-4 pt-5 pb-12 sm:px-6"
      >
        <div ref={contentRef} className="flex min-h-full flex-col justify-end gap-3">
          {transcript.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} name={name} />
          ))}
          {wait.thinking && !wait.stuck && <Thinking label={t("call.thinking", { name })} />}
          {wait.stuck && (
            <p
              role="status"
              className="flex items-center justify-center gap-1.5 text-center text-muted-foreground text-xs"
            >
              <HourglassIcon className="size-3.5 shrink-0" />
              {t("call.stuck", { name })}
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
