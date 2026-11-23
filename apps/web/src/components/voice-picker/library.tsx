import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type ListProps, SearchRow, VoiceResults } from "./parts";
import { libraryQuery } from "./queries";
import { useDebounced } from "./use-debounced";
import { SEARCH_LANGUAGES, type SearchLanguage } from "./voices";

const ANY = "any";
const LANGUAGE_NAMES = {
  zh: msg`Chinese`,
  en: msg({ message: "English", context: "voice language" }),
  ja: msg`Japanese`,
  "": msg`Any Language`,
} satisfies Record<SearchLanguage, unknown>;

export interface LibraryFilter {
  readonly text: string;
  readonly language: SearchLanguage;
}

/** Fish Audio's public voices, searched by name or style in one language. */
export function LibraryPanel({
  filter,
  onFilter,
  ...list
}: ListProps & {
  readonly filter: LibraryFilter;
  readonly onFilter: (filter: LibraryFilter) => void;
}) {
  const { t } = useLingui();
  const q = useDebounced(filter.text.trim());
  const search = useInfiniteQuery({
    ...libraryQuery(q, filter.language),
    placeholderData: keepPreviousData,
  });
  return (
    <div className="flex flex-col gap-3">
      <SearchRow
        label={t`Search Voices`}
        placeholder={t`A name or a style, e.g. 温柔`}
        text={filter.text}
        onText={(text) => onFilter({ ...filter, text })}
        fetching={search.isFetching}
        disabled={list.disabled}
      >
        <Select
          value={filter.language || ANY}
          onValueChange={(next) =>
            onFilter({ ...filter, language: SEARCH_LANGUAGES.find((code) => code === next) ?? "" })
          }
          disabled={list.disabled}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label={t`Voice Language`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEARCH_LANGUAGES.map((code) => (
              <SelectItem key={code || ANY} value={code || ANY}>
                {t(LANGUAGE_NAMES[code])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SearchRow>
      <p className="text-muted-foreground text-xs">{t`She speaks Mandarin, so the search starts among Chinese voices.`}</p>
      <VoiceResults {...list} query={search} owned={false} />
    </div>
  );
}
