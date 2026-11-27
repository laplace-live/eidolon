import { ph, t } from "@lingui/core/macro";
import { toast } from "sonner";
import { desktop, updateState } from "@/lib/desktop";

/** Shared by every check, so a repeat click replaces the pending toast instead of stacking one. */
const CHECK_TOAST_ID = "update-check";

let updateDialogOpen = false;
const updateOpenListeners = new Set<() => void>();

export function updateOpen(): boolean {
  return updateDialogOpen;
}

export function setUpdateOpen(open: boolean): void {
  if (open === updateDialogOpen) return;
  updateDialogOpen = open;
  for (const listener of [...updateOpenListeners]) listener();
}

export function subscribeUpdateOpen(listener: () => void): () => void {
  updateOpenListeners.add(listener);
  return () => {
    updateOpenListeners.delete(listener);
  };
}

/**
 * Check for Updates…, from the macOS app menu or Windows tray: runs a manual check (showing its
 * outcome in a toast), or opens the update dialog once a release, download, error, or read-only
 * notice is active.
 */
export function checkForUpdates(): void {
  const current = updateState();
  if ("version" in current || current.phase === "read-only") {
    setUpdateOpen(true);
    return;
  }
  const app = desktop();
  if (current.phase === "unsupported" || !app?.updateCheck) return;
  // Also while a quiet check runs: main joins it and surfaces skipped versions too.
  toast.loading(t`Checking for updates…`, { id: CHECK_TOAST_ID });
  const fail = (message: string) =>
    toast.error(t`Update check failed: ${ph({ message })}`, { id: CHECK_TOAST_ID });
  void app.updateCheck().then(
    (result) => {
      if (result.outcome === "available") {
        toast.dismiss(CHECK_TOAST_ID);
        setUpdateOpen(true);
      } else if (result.outcome === "none") {
        toast.success(t`You're up to date`, { id: CHECK_TOAST_ID });
      } else {
        fail(result.message);
      }
    },
    (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
  );
}
