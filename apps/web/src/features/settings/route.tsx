import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { useId } from "react";
import { useSearchParams } from "react-router";
import { SettingsForm } from "@/components/settings-form";
import { CredentialsEditor } from "@/components/settings-form/credentials-editor";
import { personasQuery, settingsQuery } from "@/components/settings-form/queries";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useT } from "@/lib/i18n";
import { statusQuery } from "@/lib/query";
import { useRestart } from "./restart";

const TABS = ["keys", "app", "persona"] as const;
type Tab = (typeof TABS)[number];

function isTab(value: string | null): value is Tab {
  return (TABS as readonly (string | null)[]).includes(value);
}

/** A saved value that waits for a restart; MCP-only staleness is said to be just that. */
function RestartBanner() {
  const t = useT();
  const status = useQuery(statusQuery);
  const { restart, restarting } = useRestart();
  const all = status.data?.restartRequired === true;
  if (!all && status.data?.mcpRestartRequired !== true) return null;
  return (
    <Alert>
      <RotateCcwIcon />
      <AlertTitle>{t(all ? "settings.restart.title" : "settings.restart.mcpTitle")}</AlertTitle>
      <AlertDescription>
        {t(all ? "settings.restart.body" : "settings.restart.mcpBody")}
      </AlertDescription>
      <AlertAction>
        <Button size="sm" disabled={restarting} onClick={() => void restart()}>
          {restarting && <Spinner />}
          {t(restarting ? "settings.restart.waiting" : "settings.restart.button")}
        </Button>
      </AlertAction>
    </Alert>
  );
}

/** What the settings files hold that the bot ignores, in the server's English. */
function FileWarnings({ warnings }: { readonly warnings: readonly string[] }) {
  const t = useT();
  if (warnings.length === 0) return null;
  return (
    <Collapsible className="rounded-lg border p-3">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left text-sm">
        <TriangleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" />
        <span className="flex-1">{t("settings.warnings", { count: warnings.length })}</span>
        <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 flex flex-col gap-1 pl-6 font-mono text-muted-foreground text-xs">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Component() {
  const t = useT();
  const pickerId = useId();
  const [params, setParams] = useSearchParams();
  const status = useQuery(statusQuery);
  const personas = useQuery(personasQuery);
  const requested = params.get("tab");
  const tab: Tab = isTab(requested) ? requested : "keys";
  const persona = params.get("persona") ?? status.data?.persona.id;
  const settings = useQuery({ ...settingsQuery(persona), enabled: persona !== undefined });

  function update(key: "tab" | "persona", value: string) {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading font-semibold text-2xl">{t("settings.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("settings.intro")}</p>
      </div>
      <RestartBanner />
      <Tabs value={tab} onValueChange={(next) => update("tab", next)}>
        <TabsList>
          {TABS.map((name) => (
            <TabsTrigger key={name} value={name}>
              {t(`settings.tab.${name}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="keys" className="pt-4">
          <CredentialsEditor />
        </TabsContent>
        <TabsContent value="app" className="flex flex-col gap-4 pt-4">
          <p className="text-muted-foreground text-sm">{t("settings.app.intro")}</p>
          {persona && <SettingsForm scope="app" persona={persona} />}
        </TabsContent>
        <TabsContent value="persona" className="flex flex-col gap-4 pt-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={pickerId}>{t("settings.persona.which")}</Label>
            <Select
              value={persona}
              onValueChange={(id) => update("persona", id)}
              disabled={!personas.data}
            >
              <SelectTrigger id={pickerId} className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(personas.data?.personas ?? []).map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                    {entry.id === personas.data?.active && ` · ${t("settings.persona.active")}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-sm">{t("settings.persona.intro")}</p>
          </div>
          {persona && <SettingsForm key={persona} scope="persona" persona={persona} />}
        </TabsContent>
      </Tabs>
      <FileWarnings warnings={settings.data?.warnings ?? []} />
    </div>
  );
}
