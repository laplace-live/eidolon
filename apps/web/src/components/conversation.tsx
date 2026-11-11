// What a call's transcript and a chat's log share: her photos, the thinking dots, and a scroller
// that keeps to the newest line.
import { ImageOffIcon } from "lucide-react";
import { type UIEvent, useCallback, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Within this many pixels of the bottom, new lines keep the view scrolled down. */
const PINNED_SLACK_PX = 48;

/**
 * A photo in a box reserved at the 3:4 selfies render at, so the log doesn't jump when it loads;
 * `failed` says why it can't be shown.
 */
export function Photo({
  src,
  alt,
  failed,
}: {
  readonly src: string;
  readonly alt: string;
  readonly failed: string;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  return (
    <div className="relative aspect-3/4 w-40 shrink-0 overflow-hidden rounded-xl bg-muted sm:w-48">
      {state === "failed" ? (
        <div className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center text-muted-foreground text-xs">
          <ImageOffIcon className="size-5" />
          {failed}
        </div>
      ) : (
        <a href={src} target="_blank" rel="noreferrer" className="block size-full">
          <img
            src={src}
            alt={alt}
            decoding="async"
            onLoad={() => setState("loaded")}
            onError={() => setState("failed")}
            className={cn("size-full object-cover", state === "loading" && "opacity-0")}
          />
        </a>
      )}
      {state === "loading" && <Skeleton className="absolute inset-0 rounded-none" />}
    </div>
  );
}

export function Thinking({ label }: { readonly label: string }) {
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
 * Keeps `scrollRef`'s scroller at the bottom as `contentRef` grows, until the viewer scrolls back
 * up; setting `pinnedRef` brings it back down.
 */
export function useStickToBottom() {
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

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    // Only scrolling up lets go: the event for a scroll to the bottom can arrive after more lines
    // did, and would read as the viewer leaving the bottom.
    const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < PINNED_SLACK_PX) pinnedRef.current = true;
    else if (scrollTop < lastTopRef.current) pinnedRef.current = false;
    lastTopRef.current = scrollTop;
  }, []);

  return { scrollRef, contentRef, pinnedRef, onScroll };
}
