import { Link } from "react-router";
import { AppMark } from "@/components/app-mark";
import { SidebarTrigger } from "@/components/ui/sidebar";

/**
 * On a phone, above a page: the button that opens the sidebar, and the logo. In the desktop app it
 * stays, empty, beside the sidebar as the row the window drags by.
 */
export function MobileBar() {
  return (
    <header
      data-window-drag
      className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-1.5 border-b bg-background/80 px-3 backdrop-blur-md md:hidden shell:md:flex shell:md:border-b-0"
    >
      <SidebarTrigger className="md:hidden" />
      <Link
        to="/"
        className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-1 font-logo font-semibold text-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
      >
        <AppMark />
        <span className="truncate">LAPLACE Eidolon</span>
      </Link>
    </header>
  );
}
