import { useLingui } from "@lingui/react/macro";
import { type QueryClient, queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  call,
  type SubspaceConnectionState,
  type SubspacePairRequest,
  type SubspaceServerUpdateRequest,
  type SubspaceShareOfferRequest,
  type SubspaceShareSettingsRequest,
  type SubspaceStateResponse,
} from "@/lib/api";
import { toastError } from "@/lib/feedback";
import { useRevalidate } from "@/router";

const SUBSPACE_KEY = ["subspace"] as const;
const PENDING_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;

export const SUBSPACE_CONNECTION_DOT: Readonly<Record<SubspaceConnectionState, string>> = {
  connected: "bg-success",
  connecting: "bg-warning",
  disconnected: "bg-muted-foreground",
  error: "bg-destructive",
};

export const subspaceQuery = queryOptions({
  queryKey: SUBSPACE_KEY,
  queryFn: ({ signal }) => call("GET /api/local/subspace", { signal }),
  refetchInterval: (query) => {
    const data = query.state.data;
    if (!data) return false;
    const busy =
      data.relayAuth.status === "pending" ||
      data.servers.some((s) => s.connectionState === "connecting");
    return busy ? PENDING_POLL_MS : IDLE_POLL_MS;
  },
});

export function activeSubspaceServer(state: SubspaceStateResponse | undefined) {
  if (state === undefined || state.activeHostId === null) return null;
  return state.servers.find((server) => server.id === state.activeHostId) ?? null;
}

export function useClipboardCopy(successMessage: string): {
  readonly copied: boolean;
  readonly copy: (text: string) => Promise<void>;
} {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 2_000);
      toast.success(successMessage);
    } catch {
      toast.error(t`Couldn't copy to clipboard.`);
    }
  }

  return { copied, copy };
}

async function resetHostCacheAndRoute(
  queryClient: QueryClient,
  pathname: string,
  navigate: (to: string, options?: { replace?: boolean }) => void,
  revalidate: () => Promise<void>,
): Promise<void> {
  const nonSubspace = (query: { readonly queryKey: readonly unknown[] }) =>
    query.queryKey[0] !== SUBSPACE_KEY[0];
  await queryClient.cancelQueries({ predicate: nonSubspace });
  queryClient.removeQueries({ predicate: nonSubspace });
  if (/^\/chats\/.+/.test(pathname)) {
    navigate("/chats", { replace: true });
  } else if (/^\/(?:personas\/|tasks(?:\/|$)|jobs\/.+)/.test(pathname)) {
    navigate("/", { replace: true });
  }
  await revalidate();
}

function useSubspaceMutation<TVariables = void, TData = SubspaceStateResponse>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  selectState: (data: TData) => SubspaceStateResponse = (data) =>
    data as unknown as SubspaceStateResponse,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data) => queryClient.setQueryData(SUBSPACE_KEY, selectState(data)),
    onError: toastError,
  });
}

/** Switches active host and clears cached data from the previous host before revalidating. */
export function useSwitchSubspaceHost(onSwitched?: () => void) {
  const queryClient = useQueryClient();
  const [pathname, navigate] = useLocation();
  const revalidate = useRevalidate();

  return useMutation({
    mutationFn: (hostId: string | null) =>
      call("POST /api/local/subspace/active", { body: { hostId } }),
    onSuccess: async (next) => {
      queryClient.setQueryData(SUBSPACE_KEY, next);
      await resetHostCacheAndRoute(queryClient, pathname, navigate, revalidate);
      onSwitched?.();
    },
    onError: toastError,
  });
}

export function usePairSubspaceServer(onPaired?: (state: SubspaceStateResponse) => void) {
  const queryClient = useQueryClient();
  const [pathname, navigate] = useLocation();
  const revalidate = useRevalidate();

  return useMutation({
    mutationFn: (body: SubspacePairRequest) => call("POST /api/local/subspace/servers", { body }),
    onSuccess: async (next, variables) => {
      queryClient.setQueryData(SUBSPACE_KEY, next);
      if (variables.activate) {
        await resetHostCacheAndRoute(queryClient, pathname, navigate, revalidate);
      }
      onPaired?.(next);
    },
    onError: toastError,
  });
}

export function useUpdateSubspaceServer() {
  return useSubspaceMutation(
    ({ id, ...body }: { readonly id: string } & SubspaceServerUpdateRequest) =>
      call("PATCH /api/local/subspace/servers/:id", { params: { id }, body }),
  );
}

export function useRemoveSubspaceServer() {
  const queryClient = useQueryClient();
  const [pathname, navigate] = useLocation();
  const revalidate = useRevalidate();
  return useMutation({
    mutationFn: (id: string) => call("DELETE /api/local/subspace/servers/:id", { params: { id } }),
    onSuccess: async (next) => {
      const previous = queryClient.getQueryData<SubspaceStateResponse>(SUBSPACE_KEY);
      queryClient.setQueryData(SUBSPACE_KEY, next);
      if (previous?.activeHostId !== next.activeHostId) {
        await resetHostCacheAndRoute(queryClient, pathname, navigate, revalidate);
      }
    },
    onError: toastError,
  });
}

export function useConnectSubspaceServer() {
  return useSubspaceMutation((id: string) =>
    call("POST /api/local/subspace/servers/:id/connect", { params: { id } }),
  );
}

export function useDisconnectSubspaceServer() {
  return useSubspaceMutation((id: string) =>
    call("POST /api/local/subspace/servers/:id/disconnect", { params: { id } }),
  );
}

export function useUpdateShareSettings() {
  return useSubspaceMutation((body: SubspaceShareSettingsRequest) =>
    call("POST /api/local/subspace/share/settings", { body }),
  );
}

export function useCreateShareOffer() {
  return useSubspaceMutation(
    (body: SubspaceShareOfferRequest) => call("POST /api/local/subspace/share/offer", { body }),
    (result) => result.state,
  );
}

export function useRevokeSubspaceGrant() {
  return useSubspaceMutation((id: string) =>
    call("DELETE /api/local/subspace/share/grants/:id", { params: { id } }),
  );
}

export function useStartRelayAuth() {
  return useSubspaceMutation(() => call("POST /api/local/subspace/auth/start"));
}

export function useLogoutRelayAuth() {
  return useSubspaceMutation(() => call("POST /api/local/subspace/auth/logout"));
}
