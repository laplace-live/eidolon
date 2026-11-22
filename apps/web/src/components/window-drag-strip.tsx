import { cn } from "@/lib/utils";

/**
 * In the desktop app, the strip a window drags by atop a screen with no row of its own, such as an
 * error; nothing in a browser.
 */
export function WindowDragStrip({ className }: { readonly className?: string }) {
  return (
    <div
      data-window-drag
      aria-hidden
      className={cn("hidden h-14 shrink-0 shell:block", className)}
    />
  );
}
