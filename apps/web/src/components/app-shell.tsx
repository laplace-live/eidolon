// The app's frame: the sidebar, and the page beside it, filling the window.

import { useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { AppSidebar } from "@/components/app-sidebar";
import { MobileBar } from "@/components/mobile-bar";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";

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
  const { key } = useLocation();
  const { setOpenMobile } = useSidebar();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a navigation only triggers it.
  useEffect(() => setOpenMobile(false), [key, setOpenMobile]);
  return null;
}

/** A page that scrolls in the frame, in a column. */
export function PageLayout() {
  return (
    <>
      <MobileBar />
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 shell:md:pt-0">
        <Outlet />
      </div>
    </>
  );
}

/** A page that fills the frame under its own header, as a chat and the call do. */
export function FrameLayout() {
  return (
    <div className="flex min-h-80 flex-1 flex-col">
      <Outlet />
    </div>
  );
}

export function AppShell() {
  const { t } = useLingui();
  const [open, setOpen] = useState(storedOpen);
  const main = useRef<HTMLElement>(null);

  return (
    <SidebarProvider
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        storeOpen(next);
      }}
      className="h-svh"
    >
      <button
        type="button"
        onClick={() => main.current?.focus()}
        className="sr-only font-medium text-sm focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-md focus:outline-none focus:ring-[3px] focus:ring-ring/50"
      >
        {t`Skip to content`}
      </button>
      <CloseOnNavigate />
      <AppSidebar />
      <SidebarInset
        id="main"
        ref={main}
        tabIndex={-1}
        className="min-w-0 overflow-y-auto outline-none"
      >
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
