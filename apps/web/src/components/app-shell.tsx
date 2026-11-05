import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation } from "react-router";
import { LanguageSwitch, ThemeMenu } from "@/components/preferences";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly end: boolean;
  /** Lit for every path under this one, not only its own. */
  readonly section?: string;
}

const START = [
  { to: "/", label: "common.nav.home", end: true },
  { to: "/call", label: "common.nav.call", end: false },
] as const satisfies readonly NavItem[];

const END = [
  { to: "/settings", label: "common.nav.settings", end: false },
  { to: "/jobs", label: "common.nav.jobs", end: false },
] as const satisfies readonly NavItem[];

function linkClass(active: boolean): string {
  return cn(
    "rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
    active && "bg-muted text-foreground",
  );
}

export function AppShell() {
  const t = useT();
  const { pathname } = useLocation();
  const { data: status } = useQuery(statusQuery);
  // The studio opens on the active persona; it stays lit on any persona's.
  const studio: NavItem[] = status
    ? [
        {
          to: `/personas/${encodeURIComponent(status.persona.id)}`,
          label: "studio.nav",
          end: false,
          section: "/personas/",
        },
      ]
    : [];
  const nav: readonly NavItem[] = [...START, ...studio, ...END];
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-4 px-4">
          <span className="font-heading font-semibold">{t("common.app.name")}</span>
          <nav className="flex items-center gap-1 text-sm">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  linkClass(
                    item.section === undefined ? isActive : pathname.startsWith(item.section),
                  )
                }
              >
                {t(item.label)}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <LanguageSwitch />
            <ThemeMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
