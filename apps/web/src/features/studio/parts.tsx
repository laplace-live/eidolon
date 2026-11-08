import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiError, type PersonaSummary, type PersonaText } from "@/lib/api";
import { errorMessage } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function LoadError({ error }: { readonly error: unknown }) {
  const { t } = useLingui();
  return (
    <Alert variant="destructive">
      <AlertTitle>{t`Couldn't load this`}</AlertTitle>
      <AlertDescription>
        {t(errorMessage(error))}
        {error instanceof ApiError && <span className="block text-xs">{error.message}</span>}
      </AlertDescription>
    </Alert>
  );
}

/** A quiet line of context inside a card, such as where a file is saved. */
export function Hint({
  icon,
  children,
  className,
}: {
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-links flex items-start gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5 text-muted-foreground text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
    >
      {icon ?? <InfoIcon />}
      <div className="min-w-0">{children}</div>
    </div>
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
  const { t } = useLingui();
  if (source !== "template") return null;
  return (
    <Hint>{t`This is ${ph({ name: persona.name })}'s built-in file. Saving keeps your copy in your data home and leaves the original unchanged.`}</Hint>
  );
}
