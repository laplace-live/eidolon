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
import { useT } from "@/lib/i18n";

/** Asks before a save of REINDEX_PATHS, which costs every index and the memories kept so far. */
export function ReindexDialog({
  open,
  onCancel,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("settings.form.reindex.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("settings.form.reindex.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("settings.form.reindex.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t("settings.form.reindex.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
