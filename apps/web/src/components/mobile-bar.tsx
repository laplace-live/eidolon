import { Link } from "react-router";
import { AppMark } from "@/components/app-mark";
import { SidebarTrigger } from "@/components/ui/sidebar";

/**
 * On a phone, above a page: the button that opens the sidebar, and the logo. The desktop app has
 * its title strip instead.
 */
export function MobileBar() {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-1.5 border-b bg-background/80 px-3 backdrop-blur-md md:hidden shell:hidden">
      <SidebarTrigger />
      <Link
        to="/"
        className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-1 font-logo font-semibold text-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <AppMark />
        <span className="truncate">LAPLACE Eidolon</span>
      </Link>
    </header>
  );
}
