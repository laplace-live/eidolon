import { useId } from "react";
import { cn } from "@/lib/utils";

/** Eidolon's mark: a crescent on a dark tile, light in dark mode. Decorative; name it beside it. */
export function AppMark({ className }: { readonly className?: string }) {
  const mask = useId();
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background",
        className,
      )}
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-[62%]">
        <mask id={mask}>
          <rect width="16" height="16" fill="white" />
          <circle cx="11" cy="5" r="5.5" fill="black" />
        </mask>
        <circle cx="8" cy="8" r="7" fill="currentColor" mask={`url(#${mask})`} />
      </svg>
    </span>
  );
}
