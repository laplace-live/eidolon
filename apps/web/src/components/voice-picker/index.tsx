// Searches Fish Audio's public voices (GET voices/search) and previews their samples: the wizard's
// voice step, persona creation and the studio's voice tab use it. Search goes out without the key,
// so it never takes a TTS slot from a live call; samples play only through <audio src>.
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { CheckIcon, HeartIcon, SearchIcon } from "lucide-react";
import { type SyntheticEvent, useEffect, useId, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { call, type Voice } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SEARCH_LANGUAGE,
  httpsOnly,
  nextPage,
  SEARCH_LANGUAGES,
  type SearchLanguage,
  totalLabel,
} from "./voices";

export interface VoicePickerProps {
  /** The chosen voice's id (FISH_VOICE_ID), or null before one is picked. */
  readonly value: string | null;
  readonly onChange: (voice: Voice) => void;
  readonly disabled?: boolean;
  /** Leaves out the line naming a chosen voice the results don't show, for a page that names it. */
  readonly hideCurrent?: boolean;
}

const DEBOUNCE_MS = 350;
const ANY = "any";

function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

export function VoicePicker({
  value,
  onChange,
  disabled = false,
  hideCurrent = false,
}: VoicePickerProps) {
  const t = useT();
  const searchId = useId();
  const [text, setText] = useState("");
  const [language, setLanguage] = useState<SearchLanguage>(DEFAULT_SEARCH_LANGUAGE);
  const q = useDebounced(text.trim());
  const playing = useRef<HTMLAudioElement | null>(null);

  const search = useInfiniteQuery({
    queryKey: ["voices", q, language],
    queryFn: ({ pageParam, signal }) =>
      call("GET /api/local/voices/search", {
        query: { q: q || undefined, language: language || undefined, page: pageParam },
        signal,
      }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) => nextPage(last, pages.length),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  const voices = [
    ...new Map(
      (search.data?.pages ?? []).flatMap((page) => page.items).map((voice) => [voice.id, voice]),
    ).values(),
  ];
  const first = search.data?.pages[0];
  const chosenShown = value !== null && voices.some((voice) => voice.id === value);

  // One sample at a time: starting another pauses the one playing.
  function onPlay(event: SyntheticEvent<HTMLAudioElement>) {
    if (playing.current && playing.current !== event.currentTarget) playing.current.pause();
    playing.current = event.currentTarget;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={searchId}>{t("setup.voice.search")}</Label>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              id={searchId}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t("setup.voice.searchPlaceholder")}
              disabled={disabled}
              autoComplete="off"
            />
            {search.isFetching && (
              <InputGroupAddon align="inline-end">
                <Spinner />
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
        <Select
          value={language || ANY}
          onValueChange={(next) => setLanguage(next === ANY ? "" : (next as SearchLanguage))}
          disabled={disabled}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label={t("setup.voice.language")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEARCH_LANGUAGES.map((code) => (
              <SelectItem key={code || ANY} value={code || ANY}>
                {t(`setup.voice.language.${code || ANY}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-muted-foreground text-xs">{t("setup.voice.mandarin")}</p>

      {value !== null && !chosenShown && !hideCurrent && (
        <p className="text-sm">
          {t("setup.voice.current")} <code className="font-mono text-xs">{value}</code>
        </p>
      )}

      {search.isError && <ErrorAlert error={search.error} />}

      {search.isPending ? (
        <div className="flex flex-col divide-y rounded-xl border bg-card">
          {["a", "b", "c"].map((key) => (
            <div key={key} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="size-12 rounded-md" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-full max-w-sm" />
              </div>
            </div>
          ))}
        </div>
      ) : voices.length === 0 && !search.isError ? (
        <EmptyState icon={<SearchIcon />} title={t("setup.voice.none")} />
      ) : (
        <>
          {first && (
            <p className="text-muted-foreground text-xs">
              {t("setup.voice.total", { count: totalLabel(first) })}
            </p>
          )}
          <ul className="flex max-h-[28rem] flex-col divide-y overflow-y-auto rounded-xl border bg-card">
            {voices.map((voice) => (
              <VoiceRow
                key={voice.id}
                voice={voice}
                chosen={voice.id === value}
                disabled={disabled}
                onChoose={() => onChange(voice)}
                onPlay={onPlay}
              />
            ))}
          </ul>
          {search.hasNextPage && (
            <Button
              variant="outline"
              onClick={() => void search.fetchNextPage()}
              disabled={search.isFetchingNextPage}
            >
              {search.isFetchingNextPage && <Spinner />}
              {t("setup.voice.more")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

interface VoiceRowProps {
  readonly voice: Voice;
  readonly chosen: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
  readonly onPlay: (event: SyntheticEvent<HTMLAudioElement>) => void;
}

function VoiceRow({ voice, chosen, disabled, onChoose, onPlay }: VoiceRowProps) {
  const t = useT();
  const cover = httpsOnly(voice.coverUrl);
  const sample = voice.samples.map((s) => httpsOnly(s.audioUrl)).find((src) => src !== null);
  return (
    <li
      className={cn(
        "flex flex-col gap-3 px-4 py-3 transition-colors sm:flex-row sm:items-center",
        chosen && "bg-muted/60",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-12 shrink-0 rounded-md bg-muted object-cover"
          />
        ) : (
          <div className="size-12 shrink-0 rounded-md bg-muted" />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium">{voice.title}</span>
            {voice.languages.slice(0, 3).map((code) => (
              <Badge key={code} variant="secondary">
                {code}
              </Badge>
            ))}
          </div>
          {voice.description && (
            <p className="line-clamp-2 text-muted-foreground text-xs">{voice.description}</p>
          )}
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="truncate">{voice.author}</span>
            <span className="flex items-center gap-0.5">
              <HeartIcon className="size-3" />
              {voice.likeCount}
            </span>
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {sample ? (
          // biome-ignore lint/a11y/useMediaCaption: a voice sample is speech the viewer listens to; Fish ships no captions for it.
          <audio
            controls
            preload="none"
            src={sample}
            onPlay={onPlay}
            className="h-8 w-56 max-w-full"
          />
        ) : (
          <span className="text-muted-foreground text-xs">{t("setup.voice.noPreview")}</span>
        )}
        <Button
          size="sm"
          variant={chosen ? "default" : "outline"}
          aria-pressed={chosen}
          disabled={disabled}
          onClick={onChoose}
        >
          {chosen && <CheckIcon />}
          {t(chosen ? "setup.voice.chosen" : "setup.voice.choose")}
        </Button>
      </div>
    </li>
  );
}
