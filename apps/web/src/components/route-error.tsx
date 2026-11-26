import { useLingui } from "@lingui/react/macro";
import { Component, type ReactNode } from "react";
import { Link } from "wouter";
import { LockedScreen } from "@/components/locked-screen";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WindowDragStrip } from "@/components/window-drag-strip";
import { ApiError, errorDetail } from "@/lib/api";
import { errorMessage } from "@/lib/labels";

interface RouteBoundaryProps {
  readonly resetKey?: string;
  readonly fallback: (error: unknown) => ReactNode;
  readonly children: ReactNode;
}

interface RouteBoundaryState {
  readonly hasError: boolean;
  readonly error: unknown;
  readonly resetKey: string | undefined;
}

/** Catches render and lazy-chunk failures inside a route subtree and resets on navigation. */
export class RouteBoundary extends Component<RouteBoundaryProps, RouteBoundaryState> {
  override state: RouteBoundaryState;

  constructor(props: RouteBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<RouteBoundaryState> {
    return { hasError: true, error };
  }

  static getDerivedStateFromProps(
    props: RouteBoundaryProps,
    state: RouteBoundaryState,
  ): Partial<RouteBoundaryState> | null {
    return props.resetKey !== state.resetKey
      ? { hasError: false, error: null, resetKey: props.resetKey }
      : null;
  }

  override render(): ReactNode {
    return this.state.hasError ? this.props.fallback(this.state.error) : this.props.children;
  }
}

/** A route's error fallback: the locked screen without a session, else what went wrong. */
export function RouteError({
  error,
  status,
}: {
  readonly error?: unknown;
  readonly status?: number;
}) {
  const { t } = useLingui();
  const resolved = status ?? (error instanceof ApiError ? error.status : null);
  if (resolved === 401) {
    return <LockedScreen expired={false} />;
  }
  return (
    <>
      <WindowDragStrip />
      <div className="mx-auto flex max-w-lg flex-col gap-4 p-6">
        <Alert variant="destructive">
          <AlertTitle>
            {resolved === 404 ? t`This page doesn't exist.` : t`Something went wrong`}
          </AlertTitle>
          {resolved !== 404 && (
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
          {resolved !== 404 && (
            // A reload, not a revalidation: a lazy route whose chunk failed to load stays failed.
            <Button onClick={() => window.location.reload()}>{t`Try Again`}</Button>
          )}
        </div>
      </div>
    </>
  );
}
