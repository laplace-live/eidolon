import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon, HomeIcon, PhoneIcon } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { VerdictLabel } from "@/features/home/hero";
import { formatsFor, readiness, verdict } from "@/features/home/readiness";
import { useLang, useT } from "@/lib/i18n";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import type { PersonaRef } from "./personas";
import { StepCard } from "./step-card";

export function DoneStep({
  persona,
  created,
  onBack,
}: {
  /** The persona the voice step set up; null when the wizard was opened at a later step. */
  readonly persona: PersonaRef | null;
  readonly created: boolean;
  readonly onBack: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const status = useQuery(statusQuery);
  const active = persona ?? status.data?.persona ?? null;
  const state = useMemo(
    () => (status.data ? verdict(readiness(status.data, formatsFor(lang))) : null),
    [status.data, lang],
  );
  return (
    <StepCard
      title={t("setup.done.title")}
      description={t("setup.done.body")}
      onBack={onBack}
      footer={
        <>
          <Button variant="outline" asChild>
            <Link to="/">
              <HomeIcon />
              {t("setup.done.home")}
            </Link>
          </Button>
          <Button asChild>
            <Link to="/call">
              <PhoneIcon />
              {t("setup.done.call", { name: active?.shortName || active?.name || "" })}
            </Link>
          </Button>
        </>
      }
    >
      {active && (
        <div className="flex items-center gap-4">
          <PersonaAvatar persona={active} size="lg" />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="break-words font-semibold text-xl tracking-tight">{active.name}</span>
            {state && (
              <span className="text-muted-foreground text-sm">
                <VerdictLabel verdict={state} />
              </span>
            )}
          </div>
        </div>
      )}
      {created && active && (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border bg-muted/40 p-4">
          <p className="min-w-0 flex-1 basis-64 text-sm">{t("setup.done.studio")}</p>
          <Button variant="outline" asChild>
            <Link to={studioPath(active.id)}>
              <BookOpenIcon />
              {t("common.openStudio")}
            </Link>
          </Button>
        </div>
      )}
    </StepCard>
  );
}
