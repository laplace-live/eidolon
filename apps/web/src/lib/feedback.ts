import { t } from "@lingui/core/macro";
import { toast } from "sonner";
import { ApiError, errorDetail } from "@/lib/api";
import { errorMessage } from "@/lib/labels";

/** A failed request as a toast: the code's string, with the server's English only as detail. */
export function toastError(error: unknown): void {
  // A 401 already sends the app to the locked screen.
  if (error instanceof ApiError && error.status === 401) return;
  toast.error(t(errorMessage(error)), {
    description: error instanceof ApiError ? errorDetail(error) : undefined,
  });
}
