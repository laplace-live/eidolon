import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useT } from "@/lib/i18n";

export interface StepCardProps {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  /** The step's own actions, at the right of the footer. */
  readonly footer: ReactNode;
  readonly onBack?: () => void;
  readonly busy?: boolean;
}

export function StepCard({ title, description, children, footer, onBack, busy }: StepCardProps) {
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-6">{children}</CardContent>
      <CardFooter className="flex flex-wrap justify-between gap-2">
        {onBack ? (
          <Button variant="ghost" onClick={onBack} disabled={busy}>
            <ArrowLeftIcon />
            {t("setup.back")}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap gap-2">{footer}</div>
      </CardFooter>
    </Card>
  );
}
