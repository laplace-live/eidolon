import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { errorDetail, errorKey } from "@/lib/api";
import { useT } from "@/lib/i18n";

/** A failed request: the app's string for its code, with the server's English as detail. */
export function ErrorAlert({ error }: { readonly error: Error | null }) {
  const t = useT();
  return (
    <Alert variant="destructive">
      <AlertTitle>{t(errorKey(error))}</AlertTitle>
      <AlertDescription>{errorDetail(error)}</AlertDescription>
    </Alert>
  );
}
