import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PhoneIcon, UserRoundXIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Link, Navigate, useParams } from "react-router";
import { toast } from "sonner";
import { PersonaAvatar } from "@/components/avatar";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SectionCardSkeleton } from "@/components/section-card";
import { SectionLayout } from "@/components/section-layout";
import { personasQuery } from "@/components/settings-form/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { activatePersona, refreshPersonas } from "@/features/setup/personas";
import type { PersonaSummary } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useT } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";
import { AdvancedSection } from "./advanced-section";
import { GlossarySection } from "./glossary-section";
import { IdentitySection } from "./identity-section";
import { KnowledgeSection } from "./knowledge-section";
import { ModelsSection } from "./models-section";
import { LoadError } from "./parts";
import { PromptSection } from "./prompt-section";
import { ReferencesSection } from "./references-section";
import { isSection, SECTIONS, type SectionId } from "./sections";
import { VideosSection } from "./videos-section";
import { VoiceSection } from "./voice-section";

const PANELS: Readonly<Record<SectionId, ComponentType<{ readonly persona: PersonaSummary }>>> = {
  identity: IdentitySection,
  prompt: PromptSection,
  voice: VoiceSection,
  models: ModelsSection,
  knowledge: KnowledgeSection,
  videos: VideosSection,
  glossary: GlossarySection,
  references: ReferencesSection,
  advanced: AdvancedSection,
};

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
      await refreshPersonas(queryClient);
    },
    onError: toastError,
  });

  return (
    <PageHeader
      leading={<PersonaAvatar persona={persona} size="lg" />}
      title={persona.name}
      badges={
        active || persona.template ? (
          <>
            {active && <Badge>{t("studio.active")}</Badge>}
            {persona.template && <Badge variant="outline">{t("studio.builtIn")}</Badge>}
          </>
        ) : undefined
      }
      description={<span className="font-mono">{persona.id}</span>}
      actions={
        active ? (
          <Button asChild>
            <Link to="/call">
              <PhoneIcon />
              {t("studio.call", { name: persona.shortName || persona.name })}
            </Link>
          </Button>
        ) : (
          <Button disabled={activate.isPending} onClick={() => activate.mutate()}>
            {activate.isPending && <Spinner />}
            {t("studio.activate")}
          </Button>
        )
      }
    >
      {persona.template ? t("studio.builtInHelp", { name: persona.name }) : undefined}
    </PageHeader>
  );
}

function Loading() {
  const t = useT();
  return (
    <div className="flex flex-col gap-8" role="status" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <div className="flex items-center gap-6">
        <Skeleton className="size-16 rounded-full" />
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-28" />
        </div>
      </div>
      <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-10">
        <div className="hidden flex-col gap-2 md:flex">
          {SECTIONS.map((id) => (
            <Skeleton key={id} className="h-9" />
          ))}
        </div>
        <SectionCardSkeleton rows={3} />
      </div>
    </div>
  );
}

export function Component() {
  const t = useT();
  const { id = "", tab } = useParams();
  const personas = useQuery(personasQuery);

  if (tab !== undefined && !isSection(tab)) {
    return <Navigate to={studioPath(id, "identity")} replace />;
  }
  if (personas.isPending) return <Loading />;
  if (personas.isError) return <LoadError error={personas.error} />;
  const persona = personas.data.personas.find((entry) => entry.id === id);
  if (!persona) {
    return (
      <EmptyState
        icon={<UserRoundXIcon />}
        title={t("studio.notFound", { id })}
        action={
          <Button variant="outline" asChild>
            <Link to="/">{t("common.error.home")}</Link>
          </Button>
        }
      />
    );
  }

  const current: SectionId = tab ?? "identity";
  const Panel = PANELS[current];
  return (
    <div className="flex flex-col gap-8">
      <Header persona={persona} active={personas.data.active === persona.id} />
      <SectionLayout
        nav={SECTIONS.map((section) => ({
          id: section,
          label: t(`studio.section.${section}`),
          href: studioPath(persona.id, section),
        }))}
        active={current}
        label={t("studio.sections", { name: persona.shortName || persona.name })}
      >
        {/* The key starts a section afresh for another persona. */}
        <Panel key={persona.id} persona={persona} />
      </SectionLayout>
    </div>
  );
}
