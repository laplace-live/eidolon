import { useLingui } from "@lingui/react/macro";
import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { LockedScreen } from "@/components/locked-screen";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError, errorDetail } from "@/lib/api";
import { errorMessage } from "@/lib/labels";

function statusOf(error: unknown): number | null {
  if (isRouteErrorResponse(error)) return error.status;
  if (error instanceof ApiError) return error.status;
  return null;
}

/** A route's ErrorBoundary: the locked screen without a session, else what went wrong. */
export function RouteError() {
  const { t } = useLingui();
  const error = useRouteError();
  const status = statusOf(error);
  if (status === 401) {
    const expired = isRouteErrorResponse(error) && error.data?.expired === true;
    return <LockedScreen expired={expired} />;
  }
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 p-6">
      <Alert variant="destructive">
        <AlertTitle>
          {status === 404 ? t`This page doesn't exist.` : t`Something went wrong`}
        </AlertTitle>
        {status !== 404 && (
          <AlertDescription>
            <p>{t(errorMessage(error))}</p>
            {error instanceof Error && <p className="font-mono text-xs">{errorDetail(error)}</p>}
          </AlertDescription>
        )}
      </Alert>
      <div className="flex gap-2">
        <Button variant="outline" asChild>
          <Link to="/">{t`Back to Home`}</Link>
        </Button>
        {status !== 404 && (
          // A reload, not a revalidation: a lazy route whose chunk failed to load stays failed.
          <Button onClick={() => window.location.reload()}>{t`Try Again`}</Button>
        )}
      </div>
    </div>
  );
}
