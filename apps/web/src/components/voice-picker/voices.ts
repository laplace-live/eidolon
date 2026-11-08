// Fish Audio's public voice search as the picker pages and shows it.
import { ph, plural, t } from "@lingui/core/macro";
import type { VoiceSearchResponse } from "@/lib/api";

/** Fish's language filter takes ISO 639-1 codes; "" searches every language. */
export const SEARCH_LANGUAGES = ["zh", "en", "ja", ""] as const;
export type SearchLanguage = (typeof SEARCH_LANGUAGES)[number];

/** Personas speak Mandarin, so a search starts among Chinese voices whatever the UI's language. */
export const DEFAULT_SEARCH_LANGUAGE: SearchLanguage = "zh";

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
