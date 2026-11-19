import logo from "@/assets/logo.svg";
import { cn } from "@/lib/utils";

/** Eidolon's logo. Decorative; name it beside it. */
export function AppMark({ className }: { readonly className?: string }) {
  return <img src={logo} alt="" className={cn("size-6 shrink-0", className)} />;
}
