import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { settingsQuery } from "@/components/settings-form/queries";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { cn } from "@/lib/utils";
import { RestartButton } from "./restart-button";

/** A saved value that waits for a restart; MCP-only staleness is said to be just that. */
function RestartBanner({ all }: { readonly all: boolean }) {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-xl border bg-card p-4 sm:px-6"
    >
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3.5">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full [&_svg]:size-4",
            all ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground",
          )}
        >
          <RotateCcwIcon aria-hidden />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5 pt-1.5 text-sm">
          <p className="font-medium leading-5">
            {t(all ? "settings.restart.title" : "settings.restart.mcpTitle")}
          </p>
          <p className="text-muted-foreground">
            {t(all ? "settings.restart.body" : "settings.restart.mcpBody")}
          </p>
        </div>
      </div>
      <div className="ml-auto">
        <RestartButton label="settings.restart.button" size="default" />
      </div>
    </div>
  );
}

/** What the settings files hold that the bot ignores, in the server's English. */
function FileWarnings({ warnings }: { readonly warnings: readonly string[] }) {
  const t = useT();
  return (
    <Collapsible className="overflow-hidden rounded-xl border bg-card">
      <CollapsibleTrigger className="group flex min-h-14 w-full items-center gap-3.5 px-4 py-3 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-6">
        <TriangleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="flex-1 font-medium">
          {warnings.length === 1
            ? t("settings.warnings.one")
            : t("settings.warnings.other", { count: warnings.length })}
        </span>
        <ChevronDownIcon
          className="size-4 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-2 border-t bg-muted/50 px-4 py-3.5 font-mono text-muted-foreground text-xs leading-5 sm:px-6">
          {warnings.map((warning) => (
            <li key={warning} className="wrap-anywhere">
              {warning}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What applies to every section: a restart a saved value waits for, and the files' problems. */
export function Notices() {
  const status = useQuery(statusQuery);
  const settings = useQuery(settingsQuery());
  const all = status.data?.restartRequired === true;
  const restart = all || status.data?.mcpRestartRequired === true;
  const warnings = settings.data?.warnings ?? [];
  if (!restart && warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {restart && <RestartBanner all={all} />}
      {warnings.length > 0 && <FileWarnings warnings={warnings} />}
    </div>
  );
}
