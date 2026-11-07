// A card of rows: a leading avatar or icon, a title over a muted line, and trailing text, buttons or
// a menu. A row with `href` links its title, and the link covers the row; trailing controls sit above
// it, so they stay their own buttons.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";

export interface ListCardProps {
  /** A muted row above the list, such as a count or "Select all". */
  readonly header?: ReactNode;
  /** The list's accessible name. */
  readonly label?: string;
  /** ListRows. */
  readonly children: ReactNode;
  readonly className?: string;
}

export function ListCard({ header, label, children, className }: ListCardProps) {
  return (
    <div
      className={cn("overflow-hidden rounded-xl border bg-card text-card-foreground", className)}
    >
      {header !== undefined && (
        <div className="flex min-h-12 flex-wrap items-center gap-3 border-b bg-muted/50 px-4 py-2.5 text-muted-foreground text-sm sm:px-6">
          {header}
        </div>
      )}
      <ul aria-label={label} className="divide-y">
        {children}
      </ul>
    </div>
  );
}

export interface ListRowProps {
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly trailing?: ReactNode;
  /** An app path the row opens. */
  readonly href?: string;
  readonly className?: string;
}

export function ListRow({ leading, title, description, trailing, href, className }: ListRowProps) {
  return (
    <li
      className={cn(
        "relative flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6",
        href !== undefined && "transition-colors hover:bg-muted/40",
        className,
      )}
    >
      {leading !== undefined && (
        <div className="flex shrink-0 items-center text-muted-foreground">{leading}</div>
      )}
      <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5 wrap-break-word">
        <div className="font-medium text-sm">
          {href === undefined ? (
            title
          ) : (
            <Link
              to={href}
              className="outline-none after:absolute after:inset-0 focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
            >
              {title}
            </Link>
          )}
        </div>
        {description !== undefined && (
          <div className="text-muted-foreground text-sm">{description}</div>
        )}
      </div>
      {trailing !== undefined && (
        <div
          className={cn(
            "relative z-10 ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2 text-sm",
            // Text there, such as a job's state and time, still opens the row.
            href !== undefined &&
              "pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto",
          )}
        >
          {trailing}
        </div>
      )}
    </li>
  );
}
