import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { Link, matchPath, Outlet, useLocation } from "react-router";
import { AppMark } from "@/components/app-mark";
import { PersonaSwitcher } from "@/components/persona-switcher";
import { LanguageSwitch, ThemeMenu } from "@/components/preferences";
import { useT } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";

interface Tab {
  readonly to: string;
  readonly label: string;
  readonly end?: boolean;
  /** Lit for every path under this one, not only its own. */
  readonly section?: string;
}

function lit(tab: Tab, pathname: string): boolean {
  if (tab.section !== undefined) return pathname.startsWith(tab.section);
  return matchPath({ path: tab.to, end: tab.end ?? false }, pathname) !== null;
}

/** The slash between the app and the persona, as a breadcrumb draws it. */
function Divider() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-5 shrink-0 text-muted-foreground/35"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      <path d="M16.88 3.55 7.12 20.45" />
    </svg>
  );
}

export function AppShell() {
  const t = useT();
  const { pathname } = useLocation();
  const { data: status } = useQuery(statusQuery);
  const main = useRef<HTMLElement>(null);
  // The studio opens on the active persona; it stays lit on any persona's.
  const tabs: readonly Tab[] = [
    { to: "/", label: "common.nav.home", end: true },
    { to: "/call", label: "common.nav.call" },
    ...(status
      ? [{ to: studioPath(status.persona.id), label: "common.nav.studio", section: "/personas/" }]
      : []),
    { to: "/jobs", label: "common.nav.jobs" },
    { to: "/settings", label: "common.nav.settings" },
  ];

  return (
    <div className="flex min-h-svh flex-col">
      <button
        type="button"
        onClick={() => main.current?.focus()}
        className="sr-only font-medium text-sm focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-md focus:outline-none focus:ring-[3px] focus:ring-ring/50"
      >
        {t("common.skip")}
      </button>
      {/* The bottom line is an inset shadow so the active tab's underline, inside the scroller, covers it. */}
      <header className="sticky top-0 z-40 bg-background/80 shadow-[inset_0_-1px_0_0_var(--border)] backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-1.5 px-4 sm:px-6">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2.5 rounded-md py-1 pr-1 font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <AppMark />
            <span className="sr-only tracking-tight sm:not-sr-only">{t("common.app.name")}</span>
          </Link>
          <Divider />
          <PersonaSwitcher />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <LanguageSwitch />
            <ThemeMenu />
          </div>
        </div>
        <nav aria-label={t("common.nav.label")} className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <ul className="no-scrollbar -mx-3 flex h-12 items-stretch overflow-x-auto">
            {tabs.map((tab) => {
              const current = lit(tab, pathname);
              return (
                <li key={tab.label} className="flex">
                  <Link
                    to={tab.to}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "group relative flex items-center px-1 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground",
                      current &&
                        "text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground",
                    )}
                  >
                    <span className="rounded-md px-2 py-1.5 transition-colors group-hover:bg-muted group-focus-visible:ring-[3px] group-focus-visible:ring-ring/50">
                      {t(tab.label)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main
        id="main"
        ref={main}
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 outline-none sm:px-6"
      >
        <Outlet />
      </main>
    </div>
  );
}
