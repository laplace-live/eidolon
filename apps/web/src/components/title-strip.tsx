// The desktop app's title bar: a strip across the window's top, with the window's own buttons, then
// Back, Forward and the sidebar's toggle. A browser has its own, and shows none of it.

import { useLingui } from "@lingui/react/macro";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { type ReactElement, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UpdateVersion } from "@/components/update-version";

/**
 * The Navigation API's, whose entries are this origin's alone: history.back() on the app's first
 * page would take the window back to the loading page it came from.
 */
function steps(): Navigation | null {
  return (globalThis as { navigation?: Navigation }).navigation ?? null;
}

function subscribe(changed: () => void): () => void {
  const navigation = steps();
  navigation?.addEventListener("currententrychange", changed);
  return () => navigation?.removeEventListener("currententrychange", changed);
}

const canGoBack = () => steps()?.canGoBack === true;
const canGoForward = () => steps()?.canGoForward === true;

export function traverse(direction: "back" | "forward"): void {
  const result = steps()?.[direction]();
  // A traversal that doesn't happen, such as one a newer navigation interrupts, rejects both.
  result?.committed?.catch(() => undefined);
  result?.finished?.catch(() => undefined);
}

function Labelled({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild aria-label={label}>
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function TitleStrip() {
  const { t } = useLingui();
  const back = useSyncExternalStore(subscribe, canGoBack, canGoBack);
  const forward = useSyncExternalStore(subscribe, canGoForward, canGoForward);
  return (
    <div
      data-window-drag
      data-title-strip
      className="fixed inset-x-0 top-0 z-20 hidden h-(--strip) items-center gap-0.5 px-2 shell:flex"
    >
      <Labelled label={t`Go Back`}>
        <Button variant="ghost" size="icon-sm" disabled={!back} onClick={() => traverse("back")}>
          <ArrowLeftIcon />
        </Button>
      </Labelled>
      <Labelled label={t`Go Forward`}>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!forward}
          onClick={() => traverse("forward")}
        >
          <ArrowRightIcon />
        </Button>
      </Labelled>
      <Labelled label={t`Toggle Sidebar`}>
        <SidebarTrigger />
      </Labelled>
      <UpdateVersion className="ml-auto" />
    </div>
  );
}
