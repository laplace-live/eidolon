// The settings card: a title, a description and the body, then a muted footer strip with a note on
// the left and the card's actions on the right. Wrap a <form> around it so footer buttons submit it.
import { type ReactNode, useId } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface SectionCardProps {
  /** The card's h2. */
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** At the right of the title, such as "Add pictures". */
  readonly action?: ReactNode;
  /** The footer's left side: where a value is saved, or a link. */
  readonly note?: ReactNode;
  /** The footer's right side, such as Save. */
  readonly actions?: ReactNode;
  readonly tone?: "default" | "danger";
  readonly id?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

const CARD = "overflow-hidden rounded-xl border bg-card text-card-foreground";
const FOOTER =
  "flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-muted/50 px-6 py-3";

export function SectionCard({
  title,
  description,
  action,
  note,
  actions,
  tone = "default",
  id,
  className,
  children,
}: SectionCardProps) {
  const titleId = useId();
  const danger = tone === "danger";
  const header = title !== undefined || description !== undefined || action !== undefined;
  return (
    <section
      id={id}
      aria-labelledby={title === undefined ? undefined : titleId}
      data-tone={tone}
      className={cn(
        CARD,
        "scroll-mt-[calc(var(--app-header-height)+1.5rem)]",
        danger && "border-destructive/40",
        className,
      )}
    >
      {(header || children !== undefined) && (
        <div className="flex flex-col gap-6 p-6">
          {header && (
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
                {title !== undefined && (
                  <h2 id={titleId} className="font-semibold text-xl tracking-tight">
                    {title}
                  </h2>
                )}
                {description !== undefined && (
                  <div className="text-muted-foreground text-sm">{description}</div>
                )}
              </div>
              {action !== undefined && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>
              )}
            </div>
          )}
          {children}
        </div>
      )}
      {(note !== undefined || actions !== undefined) && (
        <footer
          className={cn(
            FOOTER,
            danger && "border-destructive/30 bg-destructive/5 dark:bg-destructive/10",
          )}
        >
          <div className="min-w-0 text-muted-foreground text-sm [&_a]:font-medium [&_a]:text-foreground [&_a]:underline-offset-4 [&_a:hover]:underline">
            {note}
          </div>
          {actions !== undefined && (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
          )}
        </footer>
      )}
    </section>
  );
}

/** A card's shape while its data loads: `rows` fields, and the footer strip unless `footer` is false. */
export function SectionCardSkeleton({
  rows = 2,
  footer = true,
  className,
}: {
  readonly rows?: number;
  readonly footer?: boolean;
  readonly className?: string;
}) {
  const t = useT();
  return (
    <div className={cn(CARD, className)} role="status" aria-busy="true">
      <span className="sr-only">{t("common.loading")}</span>
      <div className="flex flex-col gap-6 p-6">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-sm" />
        </div>
        {Array.from({ length: rows }, (_, index) => `row-${index}`).map((key) => (
          <div key={key} className="flex flex-col gap-2.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-9 w-full max-w-md" />
          </div>
        ))}
      </div>
      {footer && (
        <div className={FOOTER}>
          <Skeleton className="h-4 w-40 bg-foreground/[0.06]" />
          <Skeleton className="h-8 w-16 bg-foreground/[0.06]" />
        </div>
      )}
    </div>
  );
}
