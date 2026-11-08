// The settings card: a title, a description and the body, then a muted footer strip with a note on
// the left and the card's actions on the right. Wrap a <form> around it so footer buttons submit it.

import { useLingui } from "@lingui/react/macro";
import { type ReactNode, useId } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  className,
  children,
}: SectionCardProps) {
  const titleId = useId();
  const danger = tone === "danger";
  const header = title !== undefined || description !== undefined || action !== undefined;
  return (
    <section
      aria-labelledby={title === undefined ? undefined : titleId}
      className={cn(CARD, danger && "border-destructive/40", className)}
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
                  <div className="inline-links text-muted-foreground text-sm">{description}</div>
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
        <SectionCardFooter note={note} actions={actions} tone={tone} />
      )}
    </section>
  );
}

/** A card's footer strip: `note` on the left, `actions` on the right. A sheet's footer too. */
export function SectionCardFooter({
  note,
  actions,
  tone = "default",
}: Pick<SectionCardProps, "note" | "actions" | "tone">) {
  return (
    <div
      className={cn(
        FOOTER,
        tone === "danger" && "border-destructive/30 bg-destructive/5 dark:bg-destructive/10",
      )}
    >
      <div className="inline-links min-w-0 text-muted-foreground text-sm">{note}</div>
      {actions !== undefined && (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
      )}
    </div>
  );
}

export interface SectionCardColumn {
  readonly id: string;
  readonly label: ReactNode;
  readonly className?: string;
}

/**
 * A table edge to edge in a card's body, its lines meeting the card's sides. `last` when nothing
 * follows it in the body, so its last row sits on the card's edge.
 */
export function SectionCardTable({
  columns,
  last = false,
  children,
}: {
  readonly columns: readonly SectionCardColumn[];
  readonly last?: boolean;
  /** Its TableRows. */
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "-mx-6 border-t [&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6",
        last && "-mb-6",
      )}
    >
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            {columns.map((column) => (
              <TableHead
                key={column.id}
                className={cn("h-9 font-normal text-muted-foreground text-xs", column.className)}
              >
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </div>
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
  const { t } = useLingui();
  return (
    <div className={cn(CARD, className)} role="status" aria-busy="true">
      <span className="sr-only">{t`Loading…`}</span>
      <div className="flex flex-col gap-6 p-6">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-full max-w-sm" />
        </div>
        <FieldSkeletons rows={rows} />
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

/** Fields still loading: a label over an input, `rows` times. */
export function FieldSkeletons({ rows }: { readonly rows: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => `row-${index}`).map((key) => (
        <div key={key} className="flex flex-col gap-2.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-full max-w-md" />
        </div>
      ))}
    </>
  );
}
