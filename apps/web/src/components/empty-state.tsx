import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  /** An icon element, such as <FileTextIcon />. */
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** What fills it: "Add facts", "Add videos". */
  readonly action?: ReactNode;
  readonly className?: string;
}

/** An empty list: a dashed box, centered, that says what goes here and how to add it. */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center",
        className,
      )}
    >
      {icon !== undefined && (
        <div className="flex size-10 items-center justify-center rounded-lg border bg-card text-muted-foreground [&_svg:not([class*='size-'])]:size-5">
          {icon}
        </div>
      )}
      <div className="flex max-w-sm flex-col gap-1">
        <div className="font-medium text-sm">{title}</div>
        {description !== undefined && (
          <div className="text-balance text-muted-foreground text-sm">{description}</div>
        )}
      </div>
      {action !== undefined && (
        <div className="flex flex-wrap items-center justify-center gap-2">{action}</div>
      )}
    </div>
  );
}
