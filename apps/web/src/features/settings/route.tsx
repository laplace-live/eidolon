// Settings for this install: keys, and what every persona shares. A persona's own settings are in
// her studio.

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import {
  BriefcaseIcon,
  DatabaseIcon,
  DownloadIcon,
  PlugIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { PageHeader } from "@/components/page-header";
import { SectionLayout } from "@/components/section-layout";
import { SettingsCard } from "@/components/settings-form/settings-card";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { AccountsCard } from "./accounts-card";
import { AssistantCard, KindsCard } from "./assistant";
import { AllowedCommandsCard } from "./commands-card";
import { McpServersCard } from "./mcp-card";
import { Notices } from "./notices";
import { CARDS, type CardId, NAMED, resolveSection, SECTIONS, type SectionId } from "./sections";
import { YtDlpBadge, YtDlpProblem } from "./yt-dlp-state";

const ICONS: Readonly<Record<SectionId, ReactNode>> = {
  providers: <PlugIcon />,
  general: <SettingsIcon />,
  memory: <DatabaseIcon />,
  downloads: <DownloadIcon />,
  assistant: <BriefcaseIcon />,
  advanced: <SlidersHorizontalIcon />,
};

const SECTION_LABELS: Readonly<Record<SectionId, MessageDescriptor>> = {
  providers: msg`Providers`,
  general: msg`General`,
  memory: msg`Memory`,
  downloads: msg`Downloads`,
  assistant: msg`Assistant Mode`,
  advanced: msg`Advanced`,
};

/** Each card's title and description, by its id in CARDS. */
const CARD_LABELS: Readonly<
  Record<CardId, { readonly title: MessageDescriptor; readonly body: MessageDescriptor }>
> = {
  you: {
    title: msg`You`,
    body: msg`What every persona knows about you.`,
  },
  storage: {
    title: msg`Storage`,
    body: msg`Every persona's memories of you live in Qdrant, and each change to them is logged to a SQLite file.`,
  },
  embeddings: {
    title: msg`Embeddings`,
    body: msg`The provider and model that turn facts, transcripts and memories into vectors for search. Every persona's index is built with them.`,
  },
  ytDlp: {
    title: msg`yt-dlp`,
    body: msg`Downloads her videos. A video behind a login needs your cookies, read from a browser or a cookies.txt.`,
  },
  assistant: {
    title: msg`Assistant Mode`,
    body: msg`Ask her in a chat to do real work on this computer, such as writing and editing files or looking things up, and she starts a task for it. Tasks run on the account and model chosen here, or a kind's below, never on her chat model, and one that needs a folder outside the folders below asks you in the chat first.`,
  },
  kinds: {
    title: msg`Models by Kind`,
    body: msg`She marks each task she starts as quick, coding or research. A kind runs on the account and model chosen for it here, and on Assistant Mode's own while none is chosen; anything else runs on Assistant Mode's own.`,
  },
};

function Section({ section }: { readonly section: SectionId }) {
  const { t } = useLingui();
  switch (section) {
    case "advanced":
      return (
        <SettingsCard
          scope="app"
          exclude={NAMED}
          title={t`Advanced`}
          description={t`Everything the other sections don't show. Most installs never change these.`}
        />
      );
    default:
      return (
        <>
          {section === "providers" && <AccountsCard />}
          {CARDS[section].map((card) => {
            const labels = {
              paths: card.paths,
              title: t(CARD_LABELS[card.id].title),
              description: t(CARD_LABELS[card.id].body),
            };
            switch (card.id) {
              case "assistant":
                return <AssistantCard key={card.id} {...labels} />;
              case "kinds":
                return <KindsCard key={card.id} {...labels} />;
              default:
                return (
                  <SettingsCard
                    key={card.id}
                    scope="app"
                    {...labels}
                    action={card.id === "ytDlp" ? <YtDlpBadge /> : undefined}
                  >
                    {card.id === "ytDlp" && <YtDlpProblem />}
                  </SettingsCard>
                );
            }
          })}
          {section === "assistant" && (
            <>
              <AllowedCommandsCard />
              <McpServersCard />
            </>
          )}
        </>
      );
  }
}

export function Component() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  // The root loader primes it, so the active persona is known from the first render.
  const persona = useQuery(statusQuery).data?.persona;
  if (!persona) return null;

  const resolved = resolveSection(params, persona.id);
  if ("redirect" in resolved) return <Navigate to={resolved.redirect} replace />;
  const { section } = resolved;
  const name = persona.name;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t`Settings`}
        description={t`Your keys and the settings every persona shares.`}
      >
        <p className="flex items-center gap-2.5">
          <PersonaAvatar persona={persona} size="xs" />
          <span>
            <Trans>
              Settings for {name} alone, such as her voice and chat model, are in{" "}
              <Link to={studioPath(persona.id)}>her studio</Link>.
            </Trans>
          </span>
        </p>
      </PageHeader>
      <SectionLayout
        label={t`Settings Sections`}
        active={section}
        nav={SECTIONS.map((id) => ({
          id,
          label: t(SECTION_LABELS[id]),
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
