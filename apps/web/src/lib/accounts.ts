// The provider accounts Settings lists and a persona's roles name, as GET accounts gives them, and
// the models each one's provider lists.
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call } from "@/lib/api";
import type { Category } from "@/lib/providers";
import { statusQuery } from "@/lib/query";

export const accountsQuery = queryOptions({
  queryKey: ["accounts"],
  queryFn: ({ signal }) => call("GET /api/local/accounts", { signal }),
});

/** What `account`'s provider lists of `category`; the server keeps a listing a few minutes. */
export function modelsQuery(account: string, category: Category) {
  return queryOptions({
    queryKey: ["accounts", account, "models", category],
    queryFn: ({ signal }) =>
      call("GET /api/local/accounts/:id/models", {
        params: { id: account },
        query: { category },
        signal,
      }),
    staleTime: 5 * 60 * 1000,
  });
}

/** After an account changes: the list, what calls need, and the settings that name accounts. */
export async function refreshAccounts(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: ["settings"] }),
  ]);
}
