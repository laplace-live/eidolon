// A page's sections: a nav beside the content on wide screens, a scroller above it on narrow ones.
import { type ReactNode, useEffect, useRef } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";

export interface SectionNavItem {
  readonly id: string;
  readonly label: string;
  /** A real URL, so the section is in the address bar: `?tab=keys`, `/personas/x/voice`. */
  readonly href: string;
  readonly icon?: ReactNode;
}

export interface SectionLayoutProps {
  readonly nav: readonly SectionNavItem[];
  /** The id of the section shown. */
  readonly active: string;
  /** The nav's accessible name. */
  readonly label: string;
  readonly children: ReactNode;
}

export function SectionLayout({ nav, active, label, children }: SectionLayoutProps) {
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const shown = useRef(active);

  useEffect(() => {
    const item = scroller.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const bar = scroller.current;
    // Below md the nav scrolls sideways: bring the active item into view without moving the page.
    if (item && bar && bar.scrollWidth > bar.clientWidth) {
      const left = item.offsetLeft - (bar.clientWidth - item.offsetWidth) / 2;
      bar.scrollTo({ left: Math.max(0, left) });
    }
    if (shown.current === active) return;
    shown.current = active;
    // A section picked from the sticky nav far down a long one starts at its own top.
    const box = root.current;
    if (
      box &&
      box.getBoundingClientRect().top < Number.parseFloat(getComputedStyle(box).scrollMarginTop)
    ) {
      box.scrollIntoView({ block: "start" });
    }
  }, [active]);

  return (
    <div
      ref={root}
      className="flex scroll-mt-[calc(var(--app-header-height)+1.5rem)] flex-col gap-8 md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:items-start md:gap-10"
    >
      <nav
        ref={scroller}
        aria-label={label}
        className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 sm:-mx-6 sm:px-6 md:sticky md:top-[calc(var(--app-header-height)+2.5rem)] md:mx-0 md:flex-col md:overflow-visible md:px-0"
      >
        {nav.map((item) => {
          const current = item.id === active;
          return (
            <Link
              key={item.id}
              to={item.href}
              aria-current={current ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-muted-foreground text-sm outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
                current && "bg-muted font-medium text-foreground hover:bg-muted",
              )}
            >
              {item.icon}
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="flex min-w-0 flex-col gap-8">{children}</div>
    </div>
  );
}
