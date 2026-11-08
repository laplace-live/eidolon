import { useLingui } from "@lingui/react/macro";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { errorDetail } from "@/lib/api";
import { errorMessage } from "@/lib/labels";

/** A failed request: the app's string for its code, with the server's English as detail. */
export function ErrorAlert({ error }: { readonly error: Error | null }) {
  const { t } = useLingui();
  return (
    <Alert variant="destructive">
      <AlertTitle>{t(errorMessage(error))}</AlertTitle>
      <AlertDescription>{errorDetail(error)}</AlertDescription>
    </Alert>
  );
}
