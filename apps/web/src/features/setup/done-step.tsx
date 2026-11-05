import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon, HomeIcon, PhoneIcon } from "lucide-react";
import { Link } from "react-router";
import { PersonaAvatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
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
  const status = useQuery(statusQuery);
  const active = persona ?? status.data?.persona ?? null;
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
          <div className="flex flex-col gap-1">
            <span className="font-heading font-semibold text-xl">{active.name}</span>
            <span className="text-muted-foreground text-sm">{t("setup.done.ready")}</span>
          </div>
        </div>
      )}
      {created && active && (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
          <p>{t("setup.done.studio")}</p>
          <Button variant="outline" className="w-fit" asChild>
            <Link to={`/personas/${encodeURIComponent(active.id)}`}>
              <BookOpenIcon />
              {t("setup.done.openStudio")}
            </Link>
          </Button>
        </div>
      )}
    </StepCard>
  );
}
