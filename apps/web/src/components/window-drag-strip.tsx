import { createContext, type ReactNode, useContext } from "react";
import { cn } from "@/lib/utils";

const BelowStrip = createContext(false);

/** What the app's frame shows below its title strip, which a screen there drags the window by. */
export function BelowTitleStrip({ children }: { readonly children: ReactNode }) {
  return <BelowStrip.Provider value>{children}</BelowStrip.Provider>;
}

/**
 * In the desktop app, the strip a window drags by atop a screen with no row of its own, such as an
 * error; nothing in a browser, or below the title strip.
 */
export function WindowDragStrip({ className }: { readonly className?: string }) {
  if (useContext(BelowStrip)) return null;
  return (
    <div
      data-window-drag
      aria-hidden
      className={cn("hidden h-(--strip) shrink-0 shell:block", className)}
    />
  );
}
