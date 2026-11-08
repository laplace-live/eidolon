// Each page is a lazily loaded src/features/<feature>/route.tsx. A route module exports route
// properties only (Component, loader, ErrorBoundary, handle): React Router copies every export onto
// the route.
import type { QueryClient } from "@tanstack/react-query";
import { createBrowserRouter, data, type LoaderFunctionArgs, redirect } from "react-router";
import { AppShell } from "@/components/app-shell";
import { RouteError } from "@/components/route-error";
import { Spinner } from "@/components/ui/spinner";
import { firstRunRedirect } from "@/features/setup/first-run";
import { ApiError, call, type Status } from "@/lib/api";
import { statusQuery } from "@/lib/query";

export interface RouterDeps {
  readonly queryClient: QueryClient;
  /** The boot's link-code exchange: null when it succeeded or there was no code. */
  readonly exchanged: Promise<ApiError | null>;
}

function Loading() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

export function createRouter({ queryClient, exchanged }: RouterDeps) {
  /** Every page needs the session: without one, RouteError shows the locked screen. */
  async function rootLoader({ request }: LoaderFunctionArgs) {
    const refused = await exchanged;
    let status: Status;
    try {
      status = await call("GET /api/local/status", { signal: request.signal });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw data({ expired: refused !== null }, { status: 401 });
      }
      throw error;
    }
    queryClient.setQueryData(statusQuery.queryKey, status);
    const target = firstRunRedirect(status, new URL(request.url).pathname);
    if (target) throw redirect(target);
    return null;
  }

  return createBrowserRouter([
    {
      path: "/",
      loader: rootLoader,
      HydrateFallback: Loading,
      ErrorBoundary: RouteError,
      children: [
        { path: "setup", lazy: () => import("@/features/setup/route") },
        {
          Component: AppShell,
          ErrorBoundary: RouteError,
          children: [
            { index: true, lazy: () => import("@/features/home/route") },
            { path: "call", lazy: () => import("@/features/call/route") },
            { path: "personas/:id/:tab?", lazy: () => import("@/features/studio/route") },
            { path: "settings", lazy: () => import("@/features/settings/route") },
            { path: "jobs/:id?", lazy: () => import("@/features/jobs/route") },
            { path: "usage", lazy: () => import("@/features/usage/route") },
          ],
        },
      ],
    },
  ]);
}
