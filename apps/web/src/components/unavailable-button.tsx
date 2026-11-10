import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** A button that can't be used now, whose tooltip says why. */
export function UnavailableButton({
  reason,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "disabled" | "onClick"> & { readonly reason: ReactNode }) {
  // aria-disabled rather than disabled, which would take the tooltip's hover and focus too.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          {...props}
          aria-disabled
          className={cn("cursor-not-allowed opacity-50 hover:bg-card", className)}
          onClick={(event) => event.preventDefault()}
        />
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{reason}</TooltipContent>
    </Tooltip>
  );
}
