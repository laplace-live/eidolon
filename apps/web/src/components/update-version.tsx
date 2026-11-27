import { useLingui } from "@lingui/react/macro";
import { CircleArrowUpIcon, CircleExclamationPointIcon, RefreshCwIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { subscribeUpdateState, updateState } from "@/lib/desktop";
import { setUpdateOpen } from "@/lib/update-check";
import { cn } from "@/lib/utils";

/** Title-bar badge naming the release on offer, absent until there is one; its icon mirrors the update phase. */
export function UpdateVersion({ className }: { readonly className?: string }) {
  const { t } = useLingui();
  const update = useSyncExternalStore(subscribeUpdateState, updateState, updateState);
  if (!("version" in update)) return null;
  const label = t`Show Update Status`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={label}
          className={cn("text-muted-foreground text-xs", className)}
          onClick={() => setUpdateOpen(true)}
        >
          {update.phase === "available" && <CircleArrowUpIcon className="size-3.5 text-link" />}
          {update.phase === "downloading" && <Spinner className="size-3.5 text-link" />}
          {update.phase === "downloaded" && <RefreshCwIcon className="size-3.5 text-link" />}
          {update.phase === "installing" && <Spinner className="size-3.5 text-link" />}
          {update.phase === "error" && (
            <CircleExclamationPointIcon className="size-3.5 text-destructive" />
          )}
          <span>v{update.version}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
