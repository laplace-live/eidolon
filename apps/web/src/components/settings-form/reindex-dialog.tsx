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
  dimensionChanged = false,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly dimensionChanged?: boolean;
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
            {dimensionChanged
              ? t`Every persona's knowledge index needs to be built again, and memory starts a new collection for the new dimension.`
              : t`Every persona's knowledge index needs to be built again, and existing viewer memories must be cleared so old and new vectors aren't mixed.`}
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
