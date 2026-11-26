// Flat Wouter routing over lazily loaded feature pages (`src/features/<feature>/route.tsx`, each
// exporting `Component`). `/companion` stays outside the session gate; every other path checks the
// session and primes `statusQuery` before mounting any page.
import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  type ComponentType,
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { AppShell, FrameLayout, PageLayout } from "@/components/app-shell";
import { LockedScreen } from "@/components/locked-screen";
import { RouteBoundary, RouteError } from "@/components/route-error";
import { Spinner } from "@/components/ui/spinner";
import { WindowDragStrip } from "@/components/window-drag-strip";
import { CompanionError, Nothing } from "@/features/companion/quiet";
import { firstRunRedirect } from "@/features/setup/first-run";
import { ApiError, call, type Status } from "@/lib/api";
import {
  createBrowserHistory,
  HistoryControllerProvider,
  type NavigateOptions,
} from "@/lib/navigation";
import { statusQuery } from "@/lib/query";

function lazyRoute(load: () => Promise<{ readonly Component: ComponentType }>) {
  return lazy(async () => ({ default: (await load()).Component }));
}

const SetupRoute = lazyRoute(() => import("@/features/setup/route"));
const HomeRoute = lazyRoute(() => import("@/features/home/route"));
const StudioRoute = lazyRoute(() => import("@/features/studio/route"));
const SettingsRoute = lazyRoute(() => import("@/features/settings/route"));
const TasksRoute = lazyRoute(() => import("@/features/tasks/route"));
const JobsRoute = lazyRoute(() => import("@/features/jobs/route"));
const UsageRoute = lazyRoute(() => import("@/features/usage/route"));
const ChatsRoute = lazyRoute(() => import("@/features/chats/route"));
const CallRoute = lazyRoute(() => import("@/features/call/route"));
const CompanionRoute = lazyRoute(() => import("@/features/companion/route"));

interface RouterDeps {
  readonly queryClient: QueryClient;
  /** The boot's link-code exchange: null when it succeeded or there was no code. */
  readonly exchanged: Promise<ApiError | null>;
}

type SessionState =
  | { readonly kind: "loading" }
  | { readonly kind: "locked"; readonly expired: boolean }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "ready" };

interface AppRouter {
  readonly element: ReactNode;
  readonly navigate: (to: string, options?: NavigateOptions) => void;
  readonly revalidate: () => Promise<void>;
}

const RevalidateContext = createContext<() => Promise<void>>(async () => {});

/** Triggers the root session check again (e.g. after redeeming a link code or receiving a 401). */
export function useRevalidate(): () => Promise<void> {
  return useContext(RevalidateContext);
}

function Loading() {
  return (
    <div className="flex min-h-svh items-center justify-center">
      <WindowDragStrip className="fixed inset-x-0 top-0" />
      <Spinner className="size-6 text-muted-foreground" />
    </div>
  );
}

export interface SessionStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => SessionState;
  readonly revalidate: () => Promise<void>;
  readonly hasStarted: () => boolean;
}

export function createSessionStore({
  queryClient,
  exchanged,
  fetchStatus = (signal) => call("GET /api/local/status", { signal }),
}: {
  readonly queryClient: QueryClient;
  readonly exchanged: Promise<ApiError | null>;
  readonly fetchStatus?: (signal: AbortSignal) => Promise<Status>;
}): SessionStore {
  let state: SessionState = { kind: "loading" };
  const listeners = new Set<() => void>();
  let inflight: AbortController | null = null;
  let generation = 0;
  let hadSession = false;
  let started = false;

  const setState = (next: SessionState) => {
    if (
      state.kind === next.kind &&
      (state.kind === "loading" ||
        state.kind === "ready" ||
        (state.kind === "locked" && next.kind === "locked" && state.expired === next.expired) ||
        (state.kind === "error" && next.kind === "error" && state.error === next.error))
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const revalidate = async (): Promise<void> => {
    started = true;
    const run = ++generation;
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    let refused: ApiError | null = null;
    try {
      refused = await exchanged;
      if (run !== generation || controller.signal.aborted) return;
      const status = await fetchStatus(controller.signal);
      if (run !== generation || controller.signal.aborted) return;
      hadSession = true;
      queryClient.setQueryData(statusQuery.queryKey, status);
      setState({ kind: "ready" });
    } catch (error) {
      if (run !== generation || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        setState({ kind: "locked", expired: !hadSession && refused !== null });
        return;
      }
      setState({ kind: "error", error });
    } finally {
      if (inflight === controller) inflight = null;
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    revalidate,
    hasStarted: () => started,
  };
}

export function SessionGate({
  store,
  children,
}: {
  readonly store: SessionStore;
  readonly children?: ReactNode;
}): ReactNode {
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { data: status } = useQuery({ ...statusQuery, enabled: session.kind === "ready" });
  const [pathname] = useLocation();

  useEffect(() => {
    if (session.kind === "loading" && !store.hasStarted()) {
      void store.revalidate();
    }
  }, [session.kind, store]);

  if (session.kind === "loading") return <Loading />;
  if (session.kind === "locked") return <LockedScreen expired={session.expired} />;
  if (session.kind === "error") return <RouteError error={session.error} />;

  const target = status ? firstRunRedirect(status, pathname) : null;
  if (target !== null) return <Redirect key={target} to={target} replace />;
  return children ?? null;
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/setup">
        {() => (
          <RouteBoundary fallback={(error) => <RouteError error={error} />}>
            <Suspense fallback={<Loading />}>
              <SetupRoute />
            </Suspense>
          </RouteBoundary>
        )}
      </Route>
      <Route>
        {() => (
          <AppShell>
            <Switch>
              <Route path="/">
                {() => (
                  <PageLayout>
                    <HomeRoute />
                  </PageLayout>
                )}
              </Route>
              <Route path="/personas/:id/:tab?">
                {() => (
                  <PageLayout>
                    <StudioRoute />
                  </PageLayout>
                )}
              </Route>
              <Route path="/settings">
                {() => (
                  <PageLayout>
                    <SettingsRoute />
                  </PageLayout>
                )}
              </Route>
              <Route path="/tasks">
                {() => (
                  <PageLayout>
                    <TasksRoute />
                  </PageLayout>
                )}
              </Route>
              <Route path="/jobs/:id?">
                {() => (
                  <PageLayout>
                    <JobsRoute />
                  </PageLayout>
                )}
              </Route>
              <Route path="/usage">
                {() => (
                  <PageLayout>
                    <UsageRoute />
                  </PageLayout>
                )}
              </Route>
              <Route path="/chats/:id?">
                {() => (
                  <FrameLayout>
                    <ChatsRoute />
                  </FrameLayout>
                )}
              </Route>
              <Route path="/call">
                {() => (
                  <FrameLayout>
                    <CallRoute />
                  </FrameLayout>
                )}
              </Route>
              <Route>{() => <RouteError status={404} />}</Route>
            </Switch>
          </AppShell>
        )}
      </Route>
    </Switch>
  );
}

function RouterView({ store }: { readonly store: SessionStore }) {
  return (
    <Switch>
      <Route path="/companion">
        {() => (
          <RouteBoundary fallback={() => <CompanionError />}>
            <Suspense fallback={<Nothing />}>
              <CompanionRoute />
            </Suspense>
          </RouteBoundary>
        )}
      </Route>
      <Route>
        {() => (
          <SessionGate store={store}>
            <AppRoutes />
          </SessionGate>
        )}
      </Route>
    </Switch>
  );
}

function RouterRoot({
  history,
  store,
}: {
  readonly history: ReturnType<typeof createBrowserHistory>;
  readonly store: SessionStore;
}) {
  return (
    <HistoryControllerProvider value={history}>
      <RevalidateContext.Provider value={store.revalidate}>
        <Router hook={history.hook} searchHook={history.searchHook}>
          <RouterView store={store} />
        </Router>
      </RevalidateContext.Provider>
    </HistoryControllerProvider>
  );
}

export function createRouter({ queryClient, exchanged }: RouterDeps): AppRouter {
  const history = createBrowserHistory();
  const store = createSessionStore({ queryClient, exchanged });
  if (typeof window !== "undefined" && window.location.pathname !== "/companion") {
    void store.revalidate();
  }

  return {
    element: <RouterRoot history={history} store={store} />,
    navigate: history.navigate,
    revalidate: store.revalidate,
  };
}
