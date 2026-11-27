import { t } from "@lingui/core/macro";
import { toast } from "sonner";
import { ApiError, errorDetail, StaleHostMutationError } from "@/lib/api";
import { errorMessage } from "@/lib/labels";

/** A failed request as a toast: the code's string, with the server's English only as detail. */
export function toastError(error: unknown): void {
  // A 401 already sends the app to the locked screen; stale writes from a previous host drop silently.
  if (
    error instanceof StaleHostMutationError ||
    (error instanceof ApiError && error.status === 401)
  ) {
    return;
  }
  toast.error(t(errorMessage(error)), {
    description: error instanceof ApiError ? errorDetail(error) : undefined,
  });
}
