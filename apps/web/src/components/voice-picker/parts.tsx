// What both of the picker's lists are made of: a search row, and the voices it found, each with a
// sample to play and a button that picks it.
import { msg, ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { CheckIcon, GlobeIcon, HeartIcon, LinkIcon, LockIcon, SearchIcon } from "lucide-react";
import { type ReactNode, type SyntheticEvent, useId } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { QuietBadge } from "@/components/quiet-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { Voice, VoiceSearchResponse, VoiceVisibility } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { httpsOnly, type VisibilityFilter, voiceCount } from "./voices";

export const VISIBILITY_LABELS = {
  "": msg`All Voices`,
  private: msg`Private`,
  unlist: msg`Unlisted`,
  public: msg`Public`,
} satisfies Record<VisibilityFilter, unknown>;

const VISIBILITY_ICONS = {
  private: LockIcon,
  unlist: LinkIcon,
  public: GlobeIcon,
} satisfies Record<VoiceVisibility, unknown>;

/** A search box over a list, with the select beside it that narrows the list further. */
export function SearchRow({
  label,
  placeholder,
  text,
  onText,
  fetching,
  disabled,
  children,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly fetching: boolean;
  readonly disabled: boolean;
  /** The select. */
  readonly children: ReactNode;
}) {
  const searchId = useId();
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-1.5">
        <Label htmlFor={searchId}>{label}</Label>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            id={searchId}
            value={text}
            onChange={(event) => onText(event.target.value)}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
          />
          {fetching && (
            <InputGroupAddon align="inline-end">
              <Spinner />
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      {children}
    </div>
  );
}

export function ResultsSkeleton() {
  return (
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
  );
}

/** What the picker hands each of its lists. */
export interface ListProps {
  /** The chosen voice's id, or null before one is picked. */
  readonly value: string | null;
  readonly hideCurrent: boolean;
  readonly disabled: boolean;
  readonly onChoose: (voice: Voice) => void;
  readonly onPlay: (event: SyntheticEvent<HTMLAudioElement>) => void;
}

interface ResultsProps extends ListProps {
  readonly query: UseInfiniteQueryResult<InfiniteData<VoiceSearchResponse>>;
  /** The account's own voices, which say who can find each and when it was made. */
  readonly owned: boolean;
}

/** The voices a list found, page by page, with Show More while there are more. */
export function VoiceResults({
  query,
  value,
  hideCurrent,
  owned,
  disabled,
  onChoose,
  onPlay,
}: ResultsProps) {
  const { t } = useLingui();
  const voices = [
    ...new Map(
      (query.data?.pages ?? []).flatMap((page) => page.items).map((voice) => [voice.id, voice]),
    ).values(),
  ];
  const first = query.data?.pages[0];
  const chosenShown = value !== null && voices.some((voice) => voice.id === value);
  return (
    <>
      {value !== null && !chosenShown && !hideCurrent && (
        <p className="text-sm">
          {t`Current voice:`} <code className="font-mono text-xs">{value}</code>
        </p>
      )}
      {query.isError && <ErrorAlert error={query.error} />}
      {query.isPending ? (
        <ResultsSkeleton />
      ) : voices.length > 0 ? (
        <>
          {first && <p className="text-muted-foreground text-xs">{voiceCount(first)}</p>}
          <ul className="flex max-h-[28rem] flex-col divide-y overflow-y-auto rounded-xl border bg-card">
            {voices.map((voice) => (
              <VoiceRow
                key={voice.id}
                voice={voice}
                owned={owned}
                chosen={voice.id === value}
                disabled={disabled}
                onChoose={() => onChoose(voice)}
                onPlay={onPlay}
              />
            ))}
          </ul>
          {query.hasNextPage && (
            <Button
              variant="outline"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage && <Spinner />}
              {t`Show More`}
            </Button>
          )}
        </>
      ) : (
        !query.isError && <EmptyState icon={<SearchIcon />} title={t`No voices match.`} />
      )}
    </>
  );
}

interface VoiceRowProps {
  readonly voice: Voice;
  readonly owned: boolean;
  readonly chosen: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
  readonly onPlay: (event: SyntheticEvent<HTMLAudioElement>) => void;
}

function VoiceRow({ voice, owned, chosen, disabled, onChoose, onPlay }: VoiceRowProps) {
  const { t } = useLingui();
  const lang = useLang();
  const cover = httpsOnly(voice.coverUrl);
  const sample = voice.samples.map((s) => httpsOnly(s.audioUrl)).find((src) => src !== null);
  const Visibility = VISIBILITY_ICONS[voice.visibility];
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
            {owned && (
              <QuietBadge>
                <Visibility aria-hidden />
                {t(VISIBILITY_LABELS[voice.visibility])}
              </QuietBadge>
            )}
          </div>
          {voice.description && (
            <p className="line-clamp-2 text-muted-foreground text-xs">{voice.description}</p>
          )}
          {owned ? (
            voice.createdAt !== null && (
              <p className="text-muted-foreground text-xs">
                {t`Created ${ph({ date: formatDate(voice.createdAt, lang) })}`}
              </p>
            )
          ) : (
            <p className="flex items-center gap-2 text-muted-foreground text-xs">
              <span className="truncate">{voice.author}</span>
              <span className="flex items-center gap-0.5">
                <HeartIcon className="size-3" />
                {voice.likeCount}
              </span>
            </p>
          )}
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
          <span className="text-muted-foreground text-xs">{t`No sample`}</span>
        )}
        <Button
          size="sm"
          variant={chosen ? "default" : "outline"}
          aria-pressed={chosen}
          disabled={disabled}
          onClick={onChoose}
        >
          {chosen && <CheckIcon />}
          {chosen ? t`Chosen` : t`Choose`}
        </Button>
      </div>
    </li>
  );
}
