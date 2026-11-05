import { queryOptions } from "@tanstack/react-query";
import { call } from "@/lib/api";

/** Every SETTINGS row for one persona; without an id, the server's active one. */
export function settingsQuery(persona?: string) {
  return queryOptions({
    queryKey: ["settings", persona ?? null],
    queryFn: ({ signal }) => call("GET /api/local/settings", { query: { persona }, signal }),
  });
}

export const credentialsQuery = queryOptions({
  queryKey: ["credentials"],
  queryFn: ({ signal }) => call("GET /api/local/credentials", { signal }),
});

export const personasQuery = queryOptions({
  queryKey: ["personas"],
  queryFn: ({ signal }) => call("GET /api/local/personas", { signal }),
});
