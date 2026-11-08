import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import {
  AudioLinesIcon,
  BookOpenIcon,
  BrainIcon,
  ClapperboardIcon,
  ImagesIcon,
  LanguagesIcon,
  PhoneIcon,
  ScrollTextIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
  UserRoundXIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { Link, Navigate, useParams } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PersonaBadges } from "@/components/persona-badges";
import { SectionCardSkeleton } from "@/components/section-card";
import { SectionLayout } from "@/components/section-layout";
import { personasQuery } from "@/components/settings-form/queries";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useActivatePersona } from "@/features/setup/personas";
import type { PersonaSummary } from "@/lib/api";
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

const SECTION_LABELS: Readonly<Record<SectionId, MessageDescriptor>> = {
  identity: msg`Profile`,
  prompt: msg`Prompt`,
  voice: msg`Voice`,
  models: msg`Mind`,
  knowledge: msg`Knowledge`,
  videos: msg`Videos`,
  glossary: msg`Glossary`,
  references: msg`Pictures`,
  advanced: msg`Advanced`,
};

const ICONS: Readonly<Record<SectionId, ReactNode>> = {
  identity: <UserRoundIcon />,
  prompt: <ScrollTextIcon />,
  voice: <AudioLinesIcon />,
  models: <BrainIcon />,
  knowledge: <BookOpenIcon />,
  videos: <ClapperboardIcon />,
  glossary: <LanguagesIcon />,
  references: <ImagesIcon />,
  advanced: <SlidersHorizontalIcon />,
};

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
  const { t } = useLingui();
  const activate = useActivatePersona();

  return (
    <PageHeader
      leading={<PersonaAvatar persona={persona} size="lg" />}
      title={persona.name}
      badges={
        active || persona.template ? (
          <PersonaBadges active={active} builtIn={persona.template} />
        ) : undefined
      }
      description={<span className="font-mono">{persona.id}</span>}
      actions={
        active ? (
          <Button asChild>
            <Link to="/call">
              <PhoneIcon />
              {t({
                message: `Call ${ph({ name: persona.shortName || persona.name })}`,
                context: "studio header",
              })}
            </Link>
          </Button>
        ) : (
          <Button disabled={activate.isPending} onClick={() => activate.mutate(persona.id)}>
            {activate.isPending && <Spinner />}
            {t`Make Active`}
          </Button>
        )
      }
    >
      {persona.template
        ? t`${ph({ name: persona.name })} ships with Eidolon. Your edits are saved in your data home, and the original stays as it is.`
        : undefined}
    </PageHeader>
  );
}

function Loading() {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-8" role="status" aria-busy="true">
      <span className="sr-only">{t`Loading…`}</span>
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
  const { t } = useLingui();
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
        title={t`There is no persona called ${id}.`}
        action={
          <Button variant="outline" asChild>
            <Link to="/">{t`Back to Home`}</Link>
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
          label: t(SECTION_LABELS[section]),
          href: studioPath(persona.id, section),
          icon: ICONS[section],
        }))}
        active={current}
        label={t`${ph({ name: persona.shortName || persona.name })}'s Studio`}
      >
        {/* The key starts a section afresh for another persona. */}
        <Panel key={persona.id} persona={persona} />
      </SectionLayout>
    </div>
  );
}
