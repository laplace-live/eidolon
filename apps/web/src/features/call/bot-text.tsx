import type { PairedTag } from "@laplace.live/eidolon-sdk";
import { cn } from "@/lib/utils";
import type { BotRun } from "./transcript";

const TAG_CLASS: Readonly<Record<PairedTag, string>> = {
  whisper: "italic opacity-60",
  emphasis: "font-semibold",
  soft: "font-light",
  fast: "tracking-tight",
  slow: "tracking-wider",
  stress: "underline underline-offset-2",
  forceful: "font-semibold underline underline-offset-2",
};

/** A reply's words with its cues as chips; words the bot has yet to say are dimmed. */
export function BotText({ runs }: { readonly runs: readonly BotRun[] }) {
  return runs.map((run) => {
    if (run.kind === "cue") {
      return (
        <span
          key={run.start}
          role="img"
          aria-label={run.name}
          title={run.name}
          className={cn("mx-0.5", run.pending && "opacity-50")}
        >
          {run.emoji}
        </span>
      );
    }
    if (run.kind === "direction") {
      return (
        <span
          key={run.start}
          title={run.text}
          className={cn(
            "mr-1 inline-block max-w-64 truncate rounded-md bg-card/70 px-1.5 align-bottom text-xs text-muted-foreground italic",
            run.pending && "opacity-60",
          )}
        >
          {run.text}
        </span>
      );
    }
    return (
      <span
        key={run.start}
        className={cn(
          run.tags.map((tag) => TAG_CLASS[tag]),
          run.pending && "text-muted-foreground",
        )}
      >
        {run.text}
      </span>
    );
  });
}
