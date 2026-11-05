import { NavLink, Outlet } from "react-router";
import { LanguageSwitch, ThemeMenu } from "@/components/preferences";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "common.nav.home", end: true },
  { to: "/call", label: "common.nav.call", end: false },
  { to: "/settings", label: "common.nav.settings", end: false },
  { to: "/jobs", label: "common.nav.jobs", end: false },
] as const;

export function AppShell() {
  const t = useT();
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-4 px-4">
          <span className="font-heading font-semibold">{t("common.app.name")}</span>
          <nav className="flex items-center gap-1 text-sm">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
                    isActive && "bg-muted text-foreground",
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
