import type { ReactNode } from "react";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * A dialog for a form or a list too long for a small one: a header over the body, which scroll
 * together, then `footer`.
 */
export function LargeDialogContent({
  title,
  description,
  footer,
  children,
}: {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    // A grid track grows to fit the widest row, such as a voice list's, past a phone's screen,
    // unless held to the dialog's width.
    <DialogContent className="max-h-[90svh] grid-cols-[minmax(0,1fr)] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
      <DialogHeader className="border-b p-6">
        <DialogTitle className="font-semibold text-xl tracking-tight">{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-6 p-6">{children}</div>
      {footer}
    </DialogContent>
  );
}
