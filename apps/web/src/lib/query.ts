import { MutationCache, QueryCache, QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, call } from "./api";

/** GET status, which the root loader primes and the pages that show readiness poll. */
export const statusQuery = queryOptions({
  queryKey: ["status"],
  queryFn: ({ signal }) => call("GET /api/local/status", { signal }),
});

function unauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/**
 * The app's client. A 401 anywhere means the session is gone, so `onUnauthorized` re-runs the
 * root loader, which shows the locked screen. A 4xx is the request's fault, so only other
 * failures are retried.
 */
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  const onError = (error: unknown) => {
    if (unauthorized(error)) onUnauthorized();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: (count, error) =>
          count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
    },
  });
}
