import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Reads the query again, after what a stream just brought is stored. While a query has no data
 * yet, TanStack Query hands an invalidation the read already in flight, even with cancelRefetch
 * (query-core's `Query.fetch`), and that read may have left before the stream's events were
 * stored: a chat opened as her greeting finished would never show it. So that read is followed by
 * one more.
 */
export async function reread(queryClient: QueryClient, queryKey: QueryKey): Promise<void> {
  const empty = queryClient.getQueryData(queryKey) === undefined;
  await queryClient.invalidateQueries({ queryKey });
  if (empty) await queryClient.invalidateQueries({ queryKey });
}
