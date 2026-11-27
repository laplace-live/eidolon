import type { MessageDescriptor } from "@lingui/core";
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  type ChangeKind,
  DESKTOP_PACKAGE,
  desktop,
  type ReleaseNoteEntry,
  subscribeUpdateState,
  type UpdateState,
  updateState,
} from "@/lib/desktop";
import { formatDate } from "@/lib/format";
import { setUpdateOpen, subscribeUpdateOpen, updateOpen } from "@/lib/update-check";
import { useLang } from "@/locales/i18n";

const KIND_BADGE: Readonly<
  Record<ChangeKind, { readonly label: MessageDescriptor; readonly className: string }>
> = {
  feature: {
    label: msg`New`,
    className: "border-transparent bg-success/10 text-success",
  },
  fix: {
    label: msg`Fixed`,
    className: "border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20",
  },
  performance: {
    label: msg`Perf`,
    className: "border-transparent bg-warning/10 text-warning",
  },
  improvement: {
    label: msg`Improved`,
    className: "border-transparent bg-primary/10 text-link",
  },
  other: {
    label: msg`Other`,
    className: "border-transparent bg-muted text-muted-foreground",
  },
};

/** What's new between the running version and the offered one, as shipped in the update manifest. */
function ReleaseNotes({ notes }: { readonly notes: readonly ReleaseNoteEntry[] }) {
  const { t } = useLingui();
  const lang = useLang();

  if (notes.length === 0) return null;
  return (
    <ScrollArea className="-mx-4 [&>[data-slot=scroll-area-viewport]]:max-h-[min(20rem,calc(100svh-var(--strip,0px)-14rem))] [&>[data-slot=scroll-area-viewport]]:px-4">
      <div className="flex flex-col gap-3">
        {notes.map((entry) => {
          const version = entry.versions[DESKTOP_PACKAGE];
          return (
            <section key={version ?? entry.date} className="flex flex-col gap-1.5">
              <h3 className="flex flex-wrap items-center gap-2">
                {version !== undefined && (
                  <span className="text-foreground text-xs">v{version}</span>
                )}
                <span className="flex-auto border-b" />
                {!Number.isNaN(Date.parse(entry.date)) && (
                  <time dateTime={entry.date} className="text-muted-foreground text-xs">
                    {formatDate(entry.date, lang)}
                  </time>
                )}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {entry.items.map((item) => (
                  <li
                    key={`${item.kind}:${item.text}`}
                    className="flex items-baseline gap-2 leading-relaxed"
                  >
                    <div className="min-w-18 shrink-0">
                      <Badge variant="outline" className={KIND_BADGE[item.kind].className}>
                        {t(KIND_BADGE[item.kind].label)}
                      </Badge>
                    </div>
                    <div className="min-w-0 whitespace-pre-line">{item.text}</div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </ScrollArea>
  );
}

/** Update prompt/progress dialog. Closing it never interrupts an in-flight download. */
export function UpdateDialog({
  open,
  onOpenChange,
  update,
  appVersion,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly update: UpdateState;
  readonly appVersion: string;
}) {
  const { t } = useLingui();
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-var(--strip,0px)-2rem)] grid-cols-[minmax(0,1fr)] overflow-x-hidden overflow-y-auto sm:max-w-lg">
        {update.phase === "available" && (
          <>
            <DialogHeader>
              <DialogTitle>{t`Update Available`}</DialogTitle>
              <DialogDescription>
                {t`v${ph({ version: update.version })} is ready to download. You're on v${ph({ appVersion })}.`}
              </DialogDescription>
            </DialogHeader>
            <ReleaseNotes notes={update.notes} />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  void desktop()?.updateSkip?.();
                  close();
                }}
              >
                {t`Skip This Version`}
              </Button>
              <Button type="button" variant="outline" onClick={close}>
                {t`Later`}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  void desktop()?.updateDownload?.();
                }}
              >
                {t`Update`}
              </Button>
            </DialogFooter>
          </>
        )}
        {update.phase === "downloading" && (
          <>
            <DialogHeader>
              <DialogTitle>{t`Downloading v${ph({ version: update.version })}…`}</DialogTitle>
              <DialogDescription>
                {t`The app stays usable; closing this dialog won't stop the download.`}
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2">
              <Progress value={update.percent} className="h-2 flex-auto" />
              <div className="w-9 text-right text-muted-foreground text-xs tabular-nums">
                {update.percent}%
              </div>
            </div>
          </>
        )}
        {(update.phase === "downloaded" || update.phase === "installing") && (
          <>
            <DialogHeader>
              <DialogTitle>{t`Ready to Install`}</DialogTitle>
              <DialogDescription>
                {t`v${ph({ version: update.version })} has been downloaded. Relaunch to apply it now, or it installs when you quit.`}
              </DialogDescription>
            </DialogHeader>
            <ReleaseNotes notes={update.notes} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                {t`Later`}
              </Button>
              {/* Locked once clicked: a second quitAndInstall relaunches the app twice. */}
              <Button
                type="button"
                disabled={update.phase === "installing"}
                onClick={() => {
                  void desktop()?.updateInstall?.();
                }}
              >
                {update.phase === "installing" && <Spinner />}
                {update.phase === "installing" ? t`Relaunching…` : t`Relaunch Now`}
              </Button>
            </DialogFooter>
          </>
        )}
        {update.phase === "error" && (
          <>
            <DialogHeader>
              <DialogTitle>{t`Update Failed`}</DialogTitle>
              <DialogDescription className="wrap-break-word">{update.message}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                {t`Later`}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  void desktop()?.updateDownload?.();
                }}
              >
                {t`Retry`}
              </Button>
            </DialogFooter>
          </>
        )}
        {update.phase === "read-only" && (
          <>
            <DialogHeader>
              <DialogTitle>{t`Move to Applications`}</DialogTitle>
              <DialogDescription>
                {t`LAPLACE Eidolon updates itself only from a folder it can write to. Move it to the Applications folder, then open it again.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" onClick={close}>
                {t`OK`}
              </Button>
            </DialogFooter>
          </>
        )}
        {(update.phase === "unsupported" ||
          update.phase === "idle" ||
          update.phase === "checking") && (
          <DialogHeader>
            <DialogTitle>{t`No Update in Progress`}</DialogTitle>
            <DialogDescription>{t`You're on v${ph({ appVersion })}.`}</DialogDescription>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  );
}

const noopSubscribe = () => () => {};

function DesktopUpdateDialog({ appVersion }: { readonly appVersion: string }) {
  const open = useSyncExternalStore(subscribeUpdateOpen, updateOpen, updateOpen);
  const update = useSyncExternalStore(
    open ? subscribeUpdateState : noopSubscribe,
    updateState,
    updateState,
  );
  // Keep the last open phase visible while Radix animates closed (e.g. Skip -> idle).
  const [shown, setShown] = useState(update);
  if (open && shown !== update) setShown(update);
  return (
    <UpdateDialog
      open={open}
      onOpenChange={setUpdateOpen}
      update={open ? update : shown}
      appVersion={appVersion}
    />
  );
}

/** Mounts UpdateDialog over the desktop window; renders nothing in a browser. */
export function UpdateDialogHost() {
  const app = desktop();
  if (app === null) return null;
  return <DesktopUpdateDialog appVersion={app.version} />;
}
