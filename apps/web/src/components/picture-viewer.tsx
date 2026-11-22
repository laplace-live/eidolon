// A picture in a chat or a call, opened full size: in a browser in a new tab, and in the desktop
// app, which has no tabs, in a viewer over the page with a button that saves it.
import { useLingui } from "@lingui/react/macro";
import { DownloadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { desktop } from "@/lib/desktop";
import { cn } from "@/lib/utils";

interface OpenPictureProps {
  readonly src: string;
  /** The picture's alt text, which the viewer shows as its title. */
  readonly alt: string;
  readonly className?: string;
  /** The picture as the page shows it, which opens it. */
  readonly children: ReactNode;
}

export function OpenPicture({ src, alt, className, children }: OpenPictureProps) {
  if (desktop() === null) {
    return (
      <a href={src} target="_blank" rel="noreferrer" className={className}>
        {children}
      </a>
    );
  }
  return (
    <PictureViewer src={src} alt={alt} className={className}>
      {children}
    </PictureViewer>
  );
}

function PictureViewer({ src, alt, className, children }: OpenPictureProps) {
  const { t } = useLingui();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={cn("cursor-zoom-in", className)}>
          {children}
        </button>
      </DialogTrigger>
      {/* Centred by its margins: from left: 50%, a fit-content width stops at half the window. */}
      <DialogContent
        aria-describedby={undefined}
        className="inset-x-0 mx-auto w-fit max-w-[calc(100vw-2rem)] translate-x-0 gap-3 p-3 sm:max-w-[calc(100vw-4rem)]"
      >
        <div className="flex min-w-0 items-center gap-3 pr-9">
          <DialogTitle className="min-w-0 flex-1 truncate font-normal text-muted-foreground text-sm">
            {alt}
          </DialogTitle>
          <Button asChild variant="outline" size="sm">
            <a href={src} download>
              <DownloadIcon data-icon="inline-start" />
              {t`Save`}
            </a>
          </Button>
        </div>
        <img
          src={src}
          alt={alt}
          className="max-h-[calc(100svh-8rem)] w-auto max-w-full justify-self-center rounded-lg object-contain"
        />
      </DialogContent>
    </Dialog>
  );
}
