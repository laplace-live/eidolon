import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { Component, type ReactNode, useContext, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { LockedScreen } from "@/components/locked-screen";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { WindowDragStrip } from "@/components/window-drag-strip";
import {
  activeSubspaceServer,
  subspaceQuery,
  useDisconnectSubspaceServer,
} from "@/features/subspace/queries";
import { ApiError, call, errorDetail } from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { errorMessage } from "@/lib/labels";
import { useOnNavigate } from "@/lib/navigation";

interface ErrorBoundaryProps {
  readonly resetKey: string;
  readonly fallback: (error: unknown) => ReactNode;
  readonly children?: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
  readonly error: unknown;
  readonly resetKey: string;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    return props.resetKey !== state.resetKey
      ? { hasError: false, error: null, resetKey: props.resetKey }
      : null;
  }

  override render(): ReactNode {
    return this.state.hasError
      ? this.props.fallback(this.state.error)
      : (this.props.children ?? null);
  }
}

/** Catches render and lazy-chunk failures inside a route subtree and resets on navigation. */
export function RouteBoundary({
  fallback,
  children,
}: {
  readonly fallback: (error: unknown) => ReactNode;
  readonly children?: ReactNode;
}) {
  const [pathname] = useLocation();
  const search = useSearch();
  const [nav, setNav] = useState(0);
  useOnNavigate(() => setNav((count) => count + 1));
  return (
    <ErrorBoundary resetKey={`${pathname}?${search}#${nav}`} fallback={fallback}>
      {children}
    </ErrorBoundary>
  );
}

function RemoteTargetNote() {
  const { t } = useLingui();
  const activeHostName =
    useQuery({
      ...subspaceQuery,
      select: (state) => activeSubspaceServer(state)?.name ?? null,
    }).data ?? null;
  if (activeHostName === null) return null;
  return <p>{t`Currently targeting remote Subspace server ${ph({ name: activeHostName })}.`}</p>;
}

function RemoteRecoveryButtons() {
  const { t } = useLingui();
  const activeServer =
    useQuery({
      ...subspaceQuery,
      select: activeSubspaceServer,
    }).data ?? null;
  const disconnect = useDisconnectSubspaceServer();
  const [switching, setSwitching] = useState(false);
  if (activeServer === null) return null;
  const busy = switching || disconnect.isPending;

  async function switchLocal(destination: string) {
    setSwitching(true);
    try {
      await call("POST /api/local/subspace/active", { body: { hostId: null } });
      window.location.assign(destination);
    } catch (err) {
      toastError(err);
      setSwitching(false);
    }
  }

  return (
    <>
      <Button variant="outline" disabled={busy} onClick={() => void switchLocal("/")}>
        {t`Switch to This Computer`}
      </Button>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void switchLocal("/settings?tab=subspace")}
      >
        {t`Open Subspace Settings`}
      </Button>
      {activeServer.connectionState !== "disconnected" && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => disconnect.mutate(activeServer.id)}
        >
          {t`Disconnect`}
        </Button>
      )}
    </>
  );
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
  // Error boundaries outside AppProviders (e.g., standalone tests) may lack QueryClientProvider.
  const hasQueryClient = useContext(QueryClientContext) !== undefined;
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
              {hasQueryClient && <RemoteTargetNote />}
              {error instanceof Error && <p className="font-mono text-xs">{errorDetail(error)}</p>}
            </AlertDescription>
          )}
        </Alert>
        <div className="flex flex-wrap gap-2">
          {hasQueryClient && <RemoteRecoveryButtons />}
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
