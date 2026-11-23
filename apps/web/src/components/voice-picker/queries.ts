import { infiniteQueryOptions } from "@tanstack/react-query";
import { call } from "@/lib/api";
import { nextPage, type SearchLanguage, type VisibilityFilter } from "./voices";

/** Fish Audio's public voices that match `q` in `language`. */
export function libraryQuery(q: string, language: SearchLanguage) {
  return infiniteQueryOptions({
    queryKey: ["voices", q, language],
    queryFn: ({ pageParam, signal }) =>
      call("GET /api/local/voices/search", {
        query: { q: q || undefined, language: language || undefined, page: pageParam },
        signal,
      }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => nextPage(last, pages.length),
    staleTime: 5 * 60_000,
  });
}

/** `account`'s own voices whose title matches `q`; kept under the account, so a new key lists afresh. */
export function ownVoicesQuery(account: string, q: string, visibility: VisibilityFilter) {
  return infiniteQueryOptions({
    queryKey: ["accounts", account, "voices", q, visibility],
    queryFn: ({ pageParam, signal }) =>
      call("GET /api/local/accounts/:id/voices", {
        params: { id: account },
        query: { q: q || undefined, visibility: visibility || undefined, page: pageParam },
        signal,
      }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => nextPage(last, pages.length),
    staleTime: 30_000,
    // A voice made on fish.audio meanwhile shows up when the viewer comes back.
    refetchOnWindowFocus: true,
  });
}
