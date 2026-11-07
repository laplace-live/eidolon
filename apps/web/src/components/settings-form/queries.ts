import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call, type SettingsResponse } from "@/lib/api";
import { statusQuery } from "@/lib/query";

/** Every SETTINGS row for one persona; without an id, the server's active one. */
export function settingsQuery(persona?: string) {
  return queryOptions({
    queryKey: ["settings", persona ?? null],
    queryFn: ({ signal }) => call("GET /api/local/settings", { query: { persona }, signal }),
  });
}

/** After a save of `persona`'s settings: its answer becomes her rows, and what shows any reloads. */
export async function refreshSettings(
  queryClient: QueryClient,
  persona: string | undefined,
  response: SettingsResponse,
): Promise<void> {
  queryClient.setQueryData(settingsQuery(persona).queryKey, response);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["settings"] }),
    queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
  ]);
}

export const credentialsQuery = queryOptions({
  queryKey: ["credentials"],
  queryFn: ({ signal }) => call("GET /api/local/credentials", { signal }),
});

export const personasQuery = queryOptions({
  queryKey: ["personas"],
  queryFn: ({ signal }) => call("GET /api/local/personas", { signal }),
});
