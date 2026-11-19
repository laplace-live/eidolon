// A task's steps, as its card's Show Steps lays them out: its words, each tool call as a row whose
// result folds out, and the lines it was told, following the newest while it runs.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockIcon,
  CornerDownRightIcon,
  LoaderCircleIcon,
  type LucideIcon,
  TerminalIcon,
} from "lucide-react";
import { memo, type ReactNode, useLayoutEffect, useRef } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { formatClock, formatCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { PAUSE_REASONS, TOOL_STATE_TEXT } from "./labels";
import { type Block, type Inline, parseMarkdown } from "./markdown";
import { type ToolRow, type ToolState, type TranscriptRow, toolState } from "./transcript";

function InlineText({ parts }: { readonly parts: readonly Inline[] }) {
  return parts.map((part) => {
    if (part.kind === "code") {
      return (
        <code key={part.at} className="rounded-sm bg-muted px-1 py-px font-mono text-[0.8125rem]">
          {part.text}
        </code>
      );
    }
    if (part.kind === "strong") return <strong key={part.at}>{part.text}</strong>;
    return <span key={part.at}>{part.text}</span>;
  });
}

function BlockView({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p>
          {block.lines.map((line, n) => (
            <span key={line.at}>
              {n > 0 && <br />}
              <InlineText parts={line.parts} />
            </span>
          ))}
        </p>
      );
    case "heading":
      return (
        <p className={cn("font-semibold", block.level <= 2 && "text-base")}>
          <InlineText parts={block.content} />
        </p>
      );
    case "list": {
      const items = block.items.map((item) => (
        <li key={item.at}>
          <InlineText parts={item.parts} />
        </li>
      ));
      return block.ordered ? (
        <ol start={block.start} className="list-decimal pl-5">
          {items}
        </ol>
      ) : (
        <ul className="list-disc pl-5">{items}</ul>
      );
    }
    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed">
          {block.text}
        </pre>
      );
    case "rule":
      return <hr className="border-border" />;
  }
}

/** Text in the Markdown the worker writes: headings, lists, code and bold, never HTML. */
export function Markdown({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 break-words text-sm leading-relaxed", className)}>
      {parseMarkdown(text).map((block) => (
        <BlockView key={block.at} block={block} />
      ))}
    </div>
  );
}

const STATE_ICONS = {
  waiting: ClockIcon,
  running: LoaderCircleIcon,
  stopped: CircleSlashIcon,
  done: CheckIcon,
  error: CircleXIcon,
} as const satisfies Record<ToolState, unknown>;

const STATE_CLASS: Record<ToolState, string> = {
  waiting: "text-muted-foreground",
  running: "animate-spin text-muted-foreground",
  stopped: "text-muted-foreground",
  done: "text-success",
  error: "text-destructive",
};

/** Each line of `text`, keyed by its offset. */
function linesOf(text: string): { readonly at: number; readonly text: string }[] {
  const lines: { at: number; text: string }[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    lines.push({ at, text: line });
    at += line.length + 1;
  }
  return lines;
}

/** An edit's diff, its added and removed lines colored. */
function Diff({ diff }: { readonly diff: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border bg-muted/40 py-2 font-mono text-xs leading-relaxed">
      {linesOf(diff).map((line) => (
        <span
          key={line.at}
          className={cn(
            "block px-3",
            line.text.startsWith("+") && "bg-success/10 text-success",
            line.text.startsWith("-") && "bg-destructive/10 text-destructive",
          )}
        >
          {line.text || " "}
        </span>
      ))}
    </pre>
  );
}

const ToolCall = memo(function ToolCall({
  row,
  running,
}: {
  readonly row: ToolRow;
  readonly running: boolean;
}) {
  const { t } = useLingui();
  const state = toolState(row, running);
  const Icon = STATE_ICONS[state];
  const { result } = row;
  const opens = result !== null || row.unparsed !== null;
  return (
    <Collapsible
      className={cn(
        "rounded-lg border bg-card",
        state === "error" && "border-destructive/40 bg-destructive/5 dark:bg-destructive/10",
      )}
    >
      <CollapsibleTrigger
        disabled={!opens}
        className="group flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 enabled:hover:bg-muted/40"
      >
        <Icon aria-hidden className={cn("size-3.5 shrink-0", STATE_CLASS[state])} />
        <span className="sr-only">{t(TOOL_STATE_TEXT[state])}: </span>
        <span className="shrink-0 font-medium font-mono text-[0.8125rem]" title={row.name}>
          {row.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
          {row.head}
        </span>
        {opens && (
          <ChevronRightIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 border-t px-3 py-2.5">
        {row.unparsed !== null && (
          <p className="text-muted-foreground text-xs">{t`Its arguments couldn't be read, so it never ran.`}</p>
        )}
        {result?.diff && <Diff diff={result.diff} />}
        {result && (
          <pre
            className={cn(
              "max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed",
              result.isError && "text-destructive",
            )}
          >
            {result.content || t`No output.`}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});

/** A quiet line across the transcript, such as where it resumed. */
function Divider({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1 text-muted-foreground text-xs">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="shrink-0">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

/** A line it was told mid-run, such as what the owner answered it, or a command's end. */
function ToldLine({
  text,
  icon: Icon = CornerDownRightIcon,
}: {
  readonly text: string;
  readonly icon?: LucideIcon;
}) {
  return (
    <p className="flex gap-2 text-muted-foreground text-xs">
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
    </p>
  );
}

function PauseLine({ row }: { readonly row: Extract<TranscriptRow, { kind: "pause" }> }) {
  const { t } = useLingui();
  const lang = useLang();
  const time = formatClock(row.at, lang);
  const reason = t(PAUSE_REASONS[row.reason]);
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <p className="text-warning">{t`Paused at ${ph({ time })}: ${ph({ reason })}`}</p>
      {row.detail && <p className="break-words text-muted-foreground text-xs">{row.detail}</p>}
    </div>
  );
}

function EndLine({ row }: { readonly row: Extract<TranscriptRow, { kind: "end" }> }) {
  const { t } = useLingui();
  const lang = useLang();
  const time = formatClock(row.at, lang);
  switch (row.outcome.status) {
    case "failed":
      return (
        <div className="flex flex-col gap-0.5 text-sm">
          <p className="font-medium text-destructive">{t`Failed at ${ph({ time })}`}</p>
          <p className="break-words text-muted-foreground text-xs">{row.outcome.error}</p>
        </div>
      );
    case "cancelled":
      return <Divider>{t`Stopped at ${ph({ time })}`}</Divider>;
    default:
      return <Divider>{t`Finished at ${ph({ time })}`}</Divider>;
  }
}

const Row = memo(function Row({
  row,
  running,
}: {
  readonly row: TranscriptRow;
  readonly running: boolean;
}) {
  const { t } = useLingui();
  const lang = useLang();
  switch (row.kind) {
    case "brief":
      return <Divider>{t`Started at ${ph({ time: formatClock(row.at, lang) })}`}</Divider>;
    case "text":
      return (
        <div className="flex flex-col gap-1">
          <Markdown text={row.text} />
          {row.finish && (
            <p className="text-warning text-xs">
              {row.finish === "cut-off"
                ? t`Cut off at the model's output limit.`
                : t`Stopped by the model's provider.`}
            </p>
          )}
        </div>
      );
    case "tool":
      return <ToolCall row={row} running={running} />;
    case "steer":
    case "follow-up":
      return <ToldLine text={row.text} />;
    case "notice":
      return <ToldLine text={row.text} icon={TerminalIcon} />;
    case "compaction":
      return (
        <Collapsible className="flex flex-col gap-2">
          <Divider>
            <CollapsibleTrigger className="rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
              {t`Earlier steps summarized, from ${ph({ tokens: formatCompact(row.tokensBefore, lang) })} tokens`}
            </CollapsibleTrigger>
          </Divider>
          <CollapsibleContent className="rounded-lg border bg-muted/40 px-3 py-2">
            <Markdown text={row.summary} className="text-xs" />
          </CollapsibleContent>
        </Collapsible>
      );
    case "pause":
      return <PauseLine row={row} />;
    case "resume":
      return <Divider>{t`Resumed at ${ph({ time: formatClock(row.at, lang) })}`}</Divider>;
    case "end":
      return <EndLine row={row} />;
  }
});

/** The rows, following the newest while the reader is at the bottom of them. */
export function TranscriptLog({
  rows,
  running,
  loading,
  className,
}: {
  readonly rows: readonly TranscriptRow[];
  readonly running: boolean;
  readonly loading: boolean;
  readonly className?: string;
}) {
  const { t } = useLingui();
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // On every change of the rows, not only their count: a result filled in, or the Working… row,
  // grows the log as much as a new row does.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows and running only trigger it.
  useLayoutEffect(() => {
    const element = box.current;
    if (element && atBottom.current && rows.length > 0) element.scrollTop = element.scrollHeight;
  }, [rows, running]);

  return (
    <div
      ref={box}
      role="log"
      aria-label={t`Steps`}
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className={cn("flex max-h-96 min-h-24 flex-col gap-3 overflow-y-auto", className)}
    >
      {rows.length === 0 && (
        <p className="text-muted-foreground text-sm">{loading ? t`Loading…` : t`Nothing yet.`}</p>
      )}
      {rows.map((row) => (
        <Row key={row.key} row={row} running={running} />
      ))}
      {running && (
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          {t`Working…`}
        </p>
      )}
    </div>
  );
}
