// The app's frame: the sidebar, the page beside it in a card, and the call, which outlives the
// page. In the desktop app both sit below the strip that stands in for the title bar.

import { useLingui } from "@lingui/react/macro";
import { type ReactNode, Suspense, useRef, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileBar } from "@/components/mobile-bar";
import { RouteBoundary, RouteError } from "@/components/route-error";
import { TitleStrip } from "@/components/title-strip";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { BelowTitleStrip } from "@/components/window-drag-strip";
import { CallBar } from "@/features/call/call-bar";
import { CallProvider } from "@/features/call/call-provider";
import { useOnNavigate } from "@/lib/navigation";

/** Whether the sidebar was left collapsed, in this browser. */
const COLLAPSED_KEY = "eidolon.sidebar.collapsed";

function storedOpen(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === null;
  } catch {
    return true;
  }
}

function storeOpen(open: boolean): void {
  try {
    if (open) localStorage.removeItem(COLLAPSED_KEY);
    else localStorage.setItem(COLLAPSED_KEY, "1");
  } catch {
    // Not kept; it still applies to this tab.
  }
}

/** A phone's sheet closes once a link in it is followed. */
function CloseOnNavigate() {
  const { setOpenMobile } = useSidebar();
  useOnNavigate(() => setOpenMobile(false));
  return null;
}

/** A page in a column, which scrolls in the frame. */
export function PageLayout({ children }: { readonly children?: ReactNode }) {
  return (
    <>
      <MobileBar />
      <div id="content" tabIndex={-1} className="outline-none">
        <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6">{children}</div>
      </div>
    </>
  );
}

/** A page that fills the frame under its own header, as a chat and the call do. */
export function FrameLayout({ children }: { readonly children?: ReactNode }) {
  return <div className="flex min-h-80 flex-1 flex-col">{children}</div>;
}

export function AppShell({ children }: { readonly children?: ReactNode }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(storedOpen);
  const main = useRef<HTMLElement>(null);

  return (
    <CallProvider>
      <SidebarProvider
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          storeOpen(next);
        }}
        className="h-svh md:bg-sidebar shell:bg-sidebar"
      >
        <button
          type="button"
          // Focused with preventScroll, or below md a browser would slide the page's top under
          // MobileBar.
          onClick={() =>
            (document.getElementById("content") ?? main.current)?.focus({ preventScroll: true })
          }
          className="sr-only font-medium text-sm focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-md focus:outline-none focus:ring-[3px] focus:ring-ring/50 shell:focus:top-[calc(var(--strip)+0.75rem)]"
        >
          {t`Skip to content`}
        </button>
        <CloseOnNavigate />
        <TitleStrip />
        <AppSidebar />
        <SidebarInset
          id="main"
          ref={main}
          tabIndex={-1}
          className="min-w-0 overflow-y-auto outline-none md:mt-2 md:rounded-tl-xl md:border-t md:border-l shell:mt-(--strip) shell:border-t"
        >
          <BelowTitleStrip>
            <RouteBoundary fallback={(error) => <RouteError error={error} />}>
              <Suspense fallback={null}>{children}</Suspense>
            </RouteBoundary>
          </BelowTitleStrip>
          <CallBar />
        </SidebarInset>
      </SidebarProvider>
    </CallProvider>
  );
}
