import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ApiError, errorKey, type PersonaSummary, type PersonaText } from "@/lib/api";
import { useT } from "@/lib/i18n";

export function LoadError({ error }: { readonly error: unknown }) {
  const t = useT();
  return (
    <Alert variant="destructive">
      <AlertTitle>{t("studio.loadFailed")}</AlertTitle>
      <AlertDescription>
        {t(errorKey(error))}
        {error instanceof ApiError && <span className="block text-xs">{error.message}</span>}
      </AlertDescription>
    </Alert>
  );
}

/** A built-in persona's file is read from the template until the first save copies it. */
export function SourceNote({
  source,
  persona,
}: {
  readonly source: PersonaText["source"];
  readonly persona: PersonaSummary;
}) {
  const t = useT();
  if (source !== "template") return null;
  return (
    <p className="flex items-start gap-2 text-muted-foreground text-xs">
      <InfoIcon className="mt-px size-3.5 shrink-0" />
      {t("studio.source.template", { name: persona.name })}
    </p>
  );
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}
