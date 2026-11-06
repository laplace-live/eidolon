import { toast } from "sonner";
import { ApiError, errorDetail, errorKey } from "@/lib/api";
import { t } from "@/lib/i18n";

/** A failed request as a toast: the code's string, with the server's English only as detail. */
export function toastError(error: unknown): void {
  // A 401 already sends the app to the locked screen.
  if (error instanceof ApiError && error.status === 401) return;
  toast.error(t(errorKey(error)), {
    description: error instanceof ApiError ? errorDetail(error) : undefined,
  });
}
