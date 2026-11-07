import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** A badge that informs without drawing the eye; `dot` colors a dot before its text. */
export function QuietBadge({
  dot,
  children,
}: {
  /** A background class, such as `bg-success`. */
  readonly dot?: string;
  readonly children: ReactNode;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("font-normal text-muted-foreground", dot !== undefined && "gap-1.5")}
    >
      {dot !== undefined && <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />}
      {children}
    </Badge>
  );
}
