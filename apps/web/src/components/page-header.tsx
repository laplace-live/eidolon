import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  /** The page's h1. */
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Before the title, such as her avatar. */
  readonly leading?: ReactNode;
  /** Beside the title and outside the h1, so they stay out of its name: Active, Built in. */
  readonly badges?: ReactNode;
  /** At the right; under the title on a phone. */
  readonly actions?: ReactNode;
  /** Under the header row, such as a line that links elsewhere. */
  readonly children?: ReactNode;
  readonly className?: string;
}

export function PageHeader({
  title,
  description,
  leading,
  badges,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4", className)}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        {leading && <div className="shrink-0">{leading}</div>}
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="min-w-0 break-words font-semibold text-3xl tracking-tight">{title}</h1>
            {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
          </div>
          {description && <div className="text-muted-foreground text-sm">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="inline-links text-muted-foreground text-sm">{children}</div>}
    </header>
  );
}
