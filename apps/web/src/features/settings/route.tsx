// Settings for this install: keys, and what every persona shares. A persona's own settings are in
// her studio.
import { useQuery } from "@tanstack/react-query";
import {
  DatabaseIcon,
  DownloadIcon,
  KeyRoundIcon,
  PlugIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { PageHeader } from "@/components/page-header";
import { SectionLayout } from "@/components/section-layout";
import { CredentialsEditor } from "@/components/settings-form/credentials-editor";
import { SettingsCard } from "@/components/settings-form/settings-card";
import { rich, type Translate, useT } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { Notices } from "./notices";
import { CARDS, NAMED, resolveSection, SECTIONS, type SectionId } from "./sections";
import { YtDlpBadge, YtDlpProblem } from "./yt-dlp-state";

const ICONS: Readonly<Record<SectionId, ReactNode>> = {
  keys: <KeyRoundIcon />,
  general: <SettingsIcon />,
  memory: <DatabaseIcon />,
  providers: <PlugIcon />,
  downloads: <DownloadIcon />,
  advanced: <SlidersHorizontalIcon />,
};

/** A card's description; `{keys}` in it links to that section. */
function describe(t: Translate, key: string): ReactNode {
  return rich(t(key), {
    keys: <Link to="?tab=keys">{t("settings.nav.keys")}</Link>,
  });
}

function Section({ section }: { readonly section: SectionId }) {
  const t = useT();
  switch (section) {
    case "keys":
      return <CredentialsEditor />;
    case "advanced":
      return (
        <SettingsCard
          scope="app"
          exclude={NAMED}
          title={t("settings.card.advanced.title")}
          description={t("settings.card.advanced.body")}
        />
      );
    default:
      return CARDS[section].map((card) => (
        <SettingsCard
          key={card.id}
          scope="app"
          paths={card.paths}
          title={t(`settings.card.${card.id}.title`)}
          description={describe(t, `settings.card.${card.id}.body`)}
          action={card.id === "ytDlp" ? <YtDlpBadge /> : undefined}
        >
          {card.id === "ytDlp" && <YtDlpProblem />}
        </SettingsCard>
      ));
  }
}

export function Component() {
  const t = useT();
  const [params] = useSearchParams();
  // The root loader primes it, so the active persona is known from the first render.
  const persona = useQuery(statusQuery).data?.persona;
  if (!persona) return null;

  const resolved = resolveSection(params, persona.id);
  if ("redirect" in resolved) return <Navigate to={resolved.redirect} replace />;
  const { section } = resolved;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t("settings.title")} description={t("settings.intro")}>
        <p className="flex items-center gap-2.5">
          <PersonaAvatar persona={persona} size="xs" />
          <span>
            {rich(t("settings.persona.line", { name: persona.name }), {
              studio: <Link to={studioPath(persona.id)}>{t("settings.persona.studio")}</Link>,
            })}
          </span>
        </p>
      </PageHeader>
      <SectionLayout
        label={t("settings.nav.label")}
        active={section}
        nav={SECTIONS.map((id) => ({
          id,
          label: t(`settings.nav.${id}`),
          href: `?tab=${id}`,
          icon: ICONS[id],
        }))}
      >
        <Notices />
        <Section key={section} section={section} />
      </SectionLayout>
    </div>
  );
}
