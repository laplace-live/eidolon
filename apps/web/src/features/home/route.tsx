import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { SectionCardSkeleton } from "@/components/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { NewPersonaDialog } from "@/features/setup/new-persona";
import { statusQuery } from "@/lib/query";
import { useLang } from "@/locales/i18n";
import { Hero } from "./hero";
import { MemoryPanel } from "./memory-panel";
import { PersonaGrid } from "./persona-grid";
import { formatsFor, readiness, verdict } from "./readiness";
import { ReadinessList } from "./readiness-list";
import { HomeSection } from "./section";
import { VoiceDialog } from "./voice-dialog";

/** Status is cheap and never waits on a remote probe, so home can poll it. */
const POLL_MS = 10_000;

function Loading() {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex items-center gap-6">
        <Skeleton className="size-24 rounded-full" />
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-36" />
        </div>
      </div>
      <SectionCardSkeleton rows={4} footer={false} />
    </div>
  );
}

export function Component() {
  const { t } = useLingui();
  const lang = useLang();
  const formats = useMemo(() => formatsFor(lang), [lang]);
  const status = useQuery({ ...statusQuery, refetchInterval: POLL_MS });
  const [pickingVoice, setPickingVoice] = useState(false);
  const [creating, setCreating] = useState(false);
  const items = useMemo(
    () => (status.data ? readiness(status.data, formats) : []),
    [status.data, formats],
  );

  if (status.isPending) return <Loading />;
  if (status.isError) return <ErrorAlert error={status.error} />;

  const { persona } = status.data;
  const live = status.data.activeCalls > 0;
  return (
    <div className="flex flex-col gap-12">
      <Hero persona={persona} verdict={verdict(items)} />

      <HomeSection
        title={t`Readiness`}
        description={t`What calls and builds need, and how to fix what's missing.`}
      >
        <ReadinessList items={items} onPickVoice={() => setPickingVoice(true)} />
      </HomeSection>

      <HomeSection
        title={t`Your Personas`}
        description={
          live
            ? t`A call is in progress: switch personas after it ends.`
            : t`Open one's studio to build her up, or make another the one your calls reach.`
        }
      >
        <PersonaGrid live={live} onNew={() => setCreating(true)} />
      </HomeSection>

      <MemoryPanel key={persona.id} persona={persona} memory={status.data.memory} />

      <p className="text-muted-foreground text-xs">
        {t`Eidolon ${ph({ version: status.data.version })}`}
      </p>

      <VoiceDialog
        persona={persona}
        current={persona.voice.id}
        open={pickingVoice}
        onOpenChange={setPickingVoice}
      />
      <NewPersonaDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
