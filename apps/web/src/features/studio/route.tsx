import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PhoneIcon } from "lucide-react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { PersonaAvatar } from "@/components/avatar";
import { personasQuery } from "@/components/settings-form/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { activatePersona } from "@/features/setup/personas";
import type { PersonaSummary } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { GlossaryTab } from "./glossary-tab";
import { IdentityTab } from "./identity-tab";
import { KnowledgeTab } from "./knowledge-tab";
import { LoadError } from "./parts";
import { PromptTab } from "./prompt-tab";
import { ReferencesTab } from "./references-tab";
import { VideosTab } from "./videos-tab";
import { VoiceTab } from "./voice-tab";

const TABS = {
  identity: IdentityTab,
  prompt: PromptTab,
  voice: VoiceTab,
  knowledge: KnowledgeTab,
  videos: VideosTab,
  glossary: GlossaryTab,
  references: ReferencesTab,
} as const;

type Tab = keyof typeof TABS;

function isTab(value: string | undefined): value is Tab {
  return value !== undefined && Object.hasOwn(TABS, value);
}

function Header({
  persona,
  active,
}: {
  readonly persona: PersonaSummary;
  readonly active: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const activate = useMutation({
    mutationFn: () => activatePersona(persona.id),
    onSuccess: async (personas) => {
      queryClient.setQueryData(personasQuery.queryKey, personas);
      toast.success(t("studio.activated", { name: persona.name }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ["settings"] }),
      ]);
    },
    onError: toastError,
  });

  return (
    <div className="flex flex-wrap items-center gap-4">
      <PersonaAvatar persona={persona} size="lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-heading font-semibold text-2xl">{persona.name}</h1>
          {active && <Badge>{t("studio.active")}</Badge>}
          {persona.template && <Badge variant="outline">{t("studio.builtIn")}</Badge>}
        </div>
        <p className="font-mono text-muted-foreground text-xs">{persona.id}</p>
        {persona.template && (
          <p className="text-muted-foreground text-xs">
            {t("studio.builtInHelp", { name: persona.name })}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        {active ? (
          <Button asChild>
            <Link to="/call">
              <PhoneIcon />
              {t("studio.call", { name: persona.shortName || persona.name })}
            </Link>
          </Button>
        ) : (
          <Button variant="outline" disabled={activate.isPending} onClick={() => activate.mutate()}>
            {activate.isPending && <Spinner />}
            {t("studio.activate")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function Component() {
  const t = useT();
  const navigate = useNavigate();
  const { id = "", tab } = useParams();
  const personas = useQuery(personasQuery);

  if (tab !== undefined && !isTab(tab)) return <Navigate to={studioPath(id, "identity")} replace />;
  if (personas.isPending) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-20" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (personas.isError) return <LoadError error={personas.error} />;
  const persona = personas.data.personas.find((entry) => entry.id === id);
  if (!persona) {
    return (
      <div className="flex flex-col items-start gap-4">
        <p className="text-muted-foreground">{t("studio.notFound", { id })}</p>
        <Button variant="outline" asChild>
          <Link to="/">{t("common.error.home")}</Link>
        </Button>
      </div>
    );
  }

  const current: Tab = tab ?? "identity";
  return (
    <div className="flex flex-col gap-6">
      <Header persona={persona} active={personas.data.active === persona.id} />
      <Tabs
        value={current}
        onValueChange={(value) => {
          if (isTab(value)) navigate(studioPath(persona.id, value));
        }}
      >
        <div className="overflow-x-auto">
          <TabsList>
            {(Object.keys(TABS) as Tab[]).map((key) => (
              <TabsTrigger key={key} value={key}>
                {t(`studio.tab.${key}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {(Object.entries(TABS) as [Tab, (typeof TABS)[Tab]][]).map(([key, Panel]) => (
          // Radix mounts only the open panel; the key starts a panel afresh for another persona.
          <TabsContent key={key} value={key} className="pt-4">
            <Panel key={persona.id} persona={persona} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
