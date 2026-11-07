import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export interface StepCardProps {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  /** The step's own actions, at the right of the footer. */
  readonly footer: ReactNode;
  /** Back, at the left of the footer; the first step has none. */
  readonly onBack?: () => void;
  /** The footer's left side when there is no Back. */
  readonly note?: ReactNode;
  readonly busy?: boolean;
}

export function StepCard({
  title,
  description,
  children,
  footer,
  onBack,
  note,
  busy,
}: StepCardProps) {
  const t = useT();
  return (
    <SectionCard
      title={title}
      description={description}
      note={
        onBack ? (
          <Button variant="ghost" className="-ml-2.5" onClick={onBack} disabled={busy}>
            <ArrowLeftIcon />
            {t("setup.back")}
          </Button>
        ) : (
          note
        )
      }
      actions={footer}
    >
      {children}
    </SectionCard>
  );
}
