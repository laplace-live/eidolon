// Browser history store for Wouter with numeric entry indexing, navigation blocking (including
// back/forward popstate reversal for LeaveDialog), and navigation listeners for the mobile sheet.
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { BaseLocationHook, BaseSearchHook } from "wouter";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export interface NavigateOptions {
  readonly replace?: boolean;
  readonly state?: unknown;
}

export type Blocker =
  | { readonly state: "unblocked"; readonly reset?: undefined; readonly proceed?: undefined }
  | { readonly state: "blocked"; readonly reset: () => void; readonly proceed: () => void }
  | { readonly state: "proceeding"; readonly reset?: undefined; readonly proceed?: undefined };

interface BrowserHistoryLike {
  readonly state: unknown;
  pushState: (data: unknown, unused: string, url?: string | URL | null) => void;
  replaceState: (data: unknown, unused: string, url?: string | URL | null) => void;
  go: (delta?: number) => void;
}

interface BrowserLocationLike {
  readonly href: string;
  readonly pathname: string;
  readonly search: string;
}

export interface BrowserWindow {
  readonly location: BrowserLocationLike;
  readonly history: BrowserHistoryLike;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
}

export interface BrowserHistoryController {
  readonly hook: BaseLocationHook;
  readonly searchHook: BaseSearchHook;
  readonly navigate: (to: string, options?: NavigateOptions) => void;
  readonly dispose: () => void;
  readonly setBlockerDirty: (id: symbol, dirty: boolean) => void;
  readonly removeBlocker: (id: symbol) => void;
  readonly subscribeBlocker: (listener: () => void) => () => void;
  readonly getBlocker: () => Blocker;
  readonly subscribeNavigate: (listener: () => void) => () => void;
}

const IDLE_BLOCKER: Blocker = { state: "unblocked" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function historyIndex(state: unknown): number | null {
  return isRecord(state) && typeof state.idx === "number" ? state.idx : null;
}

export function createBrowserHistory(
  win: BrowserWindow | null = typeof window !== "undefined" ? window : null,
): BrowserHistoryController {
  let index = 0;
  let pathname = win?.location.pathname ?? "/";
  let search = win?.location.search ?? "";

  if (win !== null) {
    const existing = historyIndex(win.history.state);
    if (existing !== null) {
      index = existing;
    } else {
      const base = isRecord(win.history.state) ? win.history.state : {};
      win.history.replaceState({ ...base, idx: 0 }, "");
    }
  }

  const locationListeners = new Set<() => void>();
  const blockerListeners = new Set<() => void>();
  const navigateListeners = new Set<() => void>();
  const dirtyBlockers = new Map<symbol, boolean>();
  let blockerState: Blocker = IDLE_BLOCKER;
  let unblockPop: (() => void) | null = null;
  let allowNextPop = false;

  const notifyLocation = () => {
    for (const listener of [...locationListeners]) listener();
  };

  const notifyNavigate = () => {
    for (const listener of [...navigateListeners]) listener();
  };

  const setBlocker = (next: Blocker) => {
    if (
      blockerState === next ||
      (blockerState.state === "unblocked" && next.state === "unblocked")
    ) {
      return;
    }
    blockerState = next;
    for (const listener of [...blockerListeners]) listener();
  };

  const shouldBlock = () => {
    for (const dirty of dirtyBlockers.values()) {
      if (dirty) return true;
    }
    return false;
  };

  const subscribeLocation = (listener: () => void) => {
    locationListeners.add(listener);
    return () => {
      locationListeners.delete(listener);
    };
  };

  const commitNavigation = (
    href: string,
    nextPath: string,
    nextSearch: string,
    options?: NavigateOptions,
  ) => {
    if (win !== null) {
      const replace = options?.replace === true;
      if (!replace) index += 1;
      const state = { usr: options?.state ?? null, idx: index };
      win.history[replace ? "replaceState" : "pushState"](state, "", href);
    }
    pathname = nextPath;
    search = nextSearch;
    notifyLocation();
    notifyNavigate();
  };

  const navigate = (to: string, options?: NavigateOptions) => {
    const base = win?.location.href ?? `http://localhost${pathname}${search}`;
    const url = new URL(to, base);
    const nextPath = url.pathname;
    const nextSearch = url.search;
    const nextHref = `${url.pathname}${url.search}${url.hash}`;

    if ((nextPath !== pathname || nextSearch !== search) && shouldBlock()) {
      setBlocker({
        state: "blocked",
        reset: () => setBlocker(IDLE_BLOCKER),
        proceed: () => {
          setBlocker(IDLE_BLOCKER);
          commitNavigation(nextHref, nextPath, nextSearch, options);
        },
      });
      return;
    }

    commitNavigation(nextHref, nextPath, nextSearch, options);
  };

  const onPopState = () => {
    if (win === null) return;
    if (unblockPop !== null) {
      const resolve = unblockPop;
      unblockPop = null;
      resolve();
      return;
    }

    const rawIdx = historyIndex(win.history.state);
    const delta = rawIdx !== null ? rawIdx - index : null;
    const nextPath = win.location.pathname;
    const nextSearch = win.location.search;

    if (
      !allowNextPop &&
      (nextPath !== pathname || nextSearch !== search) &&
      delta !== null &&
      delta !== 0 &&
      shouldBlock()
    ) {
      // Restore the browser's current entry before prompting so TitleStrip Back/Forward stay aligned.
      const restored = new Promise<void>((resolve) => {
        unblockPop = resolve;
      });
      win.history.go(-delta);
      setBlocker({
        state: "blocked",
        reset: () => setBlocker(IDLE_BLOCKER),
        proceed: () => {
          setBlocker({ state: "proceeding" });
          allowNextPop = true;
          void restored.then(() => {
            win.history.go(delta);
          });
        },
      });
      return;
    }

    allowNextPop = false;
    if (rawIdx !== null) {
      index = rawIdx;
    } else {
      index += 1;
      const base = isRecord(win.history.state) ? win.history.state : {};
      win.history.replaceState({ ...base, idx: index }, "");
    }
    pathname = nextPath;
    search = nextSearch;
    if (blockerState.state !== "unblocked") setBlocker(IDLE_BLOCKER);
    notifyLocation();
    notifyNavigate();
  };

  win?.addEventListener("popstate", onPopState);

  const searchHook: BaseSearchHook = (opts?: { readonly ssrSearch?: string }) => {
    const server = opts?.ssrSearch != null ? () => opts.ssrSearch! : () => search;
    return useSyncExternalStore(subscribeLocation, () => search, server);
  };

  const hook: BaseLocationHook = Object.assign(
    (opts?: { readonly ssrPath?: string }): [string, typeof navigate] => {
      const server = opts?.ssrPath != null ? () => opts.ssrPath! : () => pathname;
      const current = useSyncExternalStore(subscribeLocation, () => pathname, server);
      return [current, navigate];
    },
    { searchHook },
  );

  const clearBlockedIfClean = () => {
    if (!shouldBlock() && blockerState.state === "blocked") {
      setBlocker(IDLE_BLOCKER);
    }
  };

  return {
    hook,
    searchHook,
    navigate,
    dispose: () => {
      win?.removeEventListener("popstate", onPopState);
      locationListeners.clear();
      blockerListeners.clear();
      navigateListeners.clear();
      dirtyBlockers.clear();
    },
    setBlockerDirty: (id, dirty) => {
      dirtyBlockers.set(id, dirty);
      clearBlockedIfClean();
    },
    removeBlocker: (id) => {
      dirtyBlockers.delete(id);
      clearBlockedIfClean();
    },
    subscribeBlocker: (listener) => {
      blockerListeners.add(listener);
      return () => {
        blockerListeners.delete(listener);
      };
    },
    getBlocker: () => blockerState,
    subscribeNavigate: (listener) => {
      navigateListeners.add(listener);
      return () => {
        navigateListeners.delete(listener);
      };
    },
  };
}

const HistoryContext = createContext<BrowserHistoryController | null>(null);

export function HistoryControllerProvider({
  value,
  children,
}: {
  readonly value: BrowserHistoryController;
  readonly children: ReactNode;
}): ReactNode {
  return createElement(HistoryContext.Provider, { value }, children);
}

const noopSubscribe = () => () => {};
const idleSnapshot = (): Blocker => IDLE_BLOCKER;

export function useBlocker(dirty: boolean): Blocker {
  const controller = useContext(HistoryContext);
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol("blocker");
  const id = idRef.current;

  useIsomorphicLayoutEffect(() => {
    if (controller === null) return;
    controller.setBlockerDirty(id, dirty);
  }, [controller, id, dirty]);

  useIsomorphicLayoutEffect(() => {
    if (controller === null) return;
    return () => controller.removeBlocker(id);
  }, [controller, id]);

  return useSyncExternalStore(
    controller ? controller.subscribeBlocker : noopSubscribe,
    controller ? controller.getBlocker : idleSnapshot,
    idleSnapshot,
  );
}

export function useBeforeUnload(callback: (event: BeforeUnloadEvent) => void): void {
  const latest = useRef(callback);
  useIsomorphicLayoutEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => latest.current(event);
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);
}

export function useOnNavigate(listener: () => void): void {
  const controller = useContext(HistoryContext);
  const latest = useRef(listener);
  useIsomorphicLayoutEffect(() => {
    latest.current = listener;
  });
  useEffect(() => {
    if (controller === null) return;
    return controller.subscribeNavigate(() => latest.current());
  }, [controller]);
}
