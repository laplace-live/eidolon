// Fish Audio's voices as the picker pages and shows them: the public library, and the account's own.
import { ph, plural, t } from "@lingui/core/macro";
import type { AccountVoicesResponse, VoiceSearchResponse, VoiceVisibility } from "@/lib/api";

/** Fish's language filter takes ISO 639-1 codes; "" searches every language. */
export const SEARCH_LANGUAGES = ["zh", "en", "ja", ""] as const;
export type SearchLanguage = (typeof SEARCH_LANGUAGES)[number];

/** Personas speak Mandarin, so a search starts among Chinese voices whatever the UI's language. */
export const DEFAULT_SEARCH_LANGUAGE: SearchLanguage = "zh";

/** The account's own voices by who can find them; "" lists every one. */
export const VISIBILITY_FILTERS: readonly VisibilityFilter[] = ["", "private", "unlist", "public"];
export type VisibilityFilter = VoiceVisibility | "";

/** The picker's two lists. */
export type VoiceSource = "mine" | "library";

/** A third-party URL the page may load: https only. */
export function httpsOnly(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The page after the last one loaded, or undefined once Fish says there are no more. */
export function nextPage(
  last: Pick<VoiceSearchResponse, "hasMore">,
  loaded: number,
): number | undefined {
  return last.hasMore ? loaded + 1 : undefined;
}

/** How many voices a search found: "1 voice", or "1,000+ voices" where Fish caps the count. */
export function voiceCount(response: Pick<VoiceSearchResponse, "total" | "totalIsExact">): string {
  const count = response.total;
  return response.totalIsExact
    ? t`${plural(ph({ count }), { one: "# voice", other: "# voices" })}`
    : t`${plural(ph({ count }), { other: "#+ voices" })}`;
}

/**
 * The list the picker opens on, from the first page of the account's own voices: those once it
 * has any, else the library, which is also where it opens when they can't be listed; null while
 * they load.
 */
export function openingSource(
  own: Pick<AccountVoicesResponse, "status" | "items"> | undefined,
  failed: boolean,
): VoiceSource | null {
  if (own !== undefined) return own.status === "ok" && own.items.length > 0 ? "mine" : "library";
  return failed ? "library" : null;
}
