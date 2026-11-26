import { useLingui } from "@lingui/react/macro";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** Asks before a save of REINDEX_PATHS or embedding provider, which requires rebuilding indexes. */
export function ReindexDialog({
  open,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useLingui();
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Change the embedding model?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {t`Every persona's knowledge index needs to be built again, and memory starts a new collection for the new embedding settings.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t`Save Anyway`}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
