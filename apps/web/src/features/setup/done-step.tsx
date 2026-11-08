import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon, HomeIcon, PhoneIcon } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { VerdictLabel } from "@/features/home/hero";
import { formatsFor, readiness, verdict } from "@/features/home/readiness";
import { studioPath } from "@/lib/paths";
import { statusQuery } from "@/lib/query";
import { useLang } from "@/locales/i18n";
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
  const { t } = useLingui();
  const lang = useLang();
  const status = useQuery(statusQuery);
  const active = persona ?? status.data?.persona ?? null;
  const state = useMemo(
    () => (status.data ? verdict(readiness(status.data, formatsFor(lang))) : null),
    [status.data, lang],
  );
  return (
    <StepCard
      title={t`You're all set`}
      description={t`Your keys, persona and voice are saved.`}
      onBack={onBack}
      footer={
        <>
          <Button variant="outline" asChild>
            <Link to="/">
              <HomeIcon />
              {t`Go to Home`}
            </Link>
          </Button>
          <Button asChild>
            <Link to="/call">
              <PhoneIcon />
              {t`Call ${ph({ name: active?.shortName || active?.name || "" })}`}
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
          <p className="min-w-0 flex-1 basis-64 text-sm">{t`Give her facts, videos and outfits in the studio, so she knows who she is.`}</p>
          <Button variant="outline" asChild>
            <Link to={studioPath(active.id)}>
              <BookOpenIcon />
              {t`Open the Studio`}
            </Link>
          </Button>
        </div>
      )}
    </StepCard>
  );
}
