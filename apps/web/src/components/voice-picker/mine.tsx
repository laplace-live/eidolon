import { Trans, useLingui } from "@lingui/react/macro";
import { useInfiniteQuery } from "@tanstack/react-query";
import { AudioLinesIcon, ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { Link } from "wouter";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AccountVoicesResponse } from "@/lib/api";
import { type ListProps, SearchRow, VISIBILITY_LABELS, VoiceResults } from "./parts";
import { ownVoicesQuery } from "./queries";
import { useDebounced } from "./use-debounced";
import { VISIBILITY_FILTERS, type VisibilityFilter } from "./voices";

const CREATE_VOICE_URL = "https://fish.audio/app/create-voice/";
const PROVIDERS_PATH = "/settings?tab=providers";
const ALL = "all";

export interface OwnFilter {
  readonly text: string;
  readonly visibility: VisibilityFilter;
}

/** Why the account's voices can't be listed: it has no key, or Fish refused the one it has. */
function KeyProblem({ status }: { readonly status: "no-key" | "refused" }) {
  const { t } = useLingui();
  return (
    <EmptyState
      icon={<KeyRoundIcon />}
      title={
        status === "no-key"
          ? t`This account has no key yet`
          : t`Fish Audio refused this account's key`
      }
      description={
        <span className="inline-links">
          {status === "no-key" ? (
            <Trans>
              Add its key in <Link to={PROVIDERS_PATH}>Settings → Providers</Link> to see the voices
              you made on Fish Audio.
            </Trans>
          ) : (
            <Trans>
              Check it in <Link to={PROVIDERS_PATH}>Settings → Providers</Link>.
            </Trans>
          )}
        </span>
      }
    />
  );
}

/** The voices a Fish account made, its private ones included, newest first. */
export function MinePanel({
  account,
  overview,
  filter,
  onFilter,
  ...list
}: ListProps & {
  readonly account: string;
  /** The first page of every voice of the account, whatever the filter; undefined while it loads. */
  readonly overview: AccountVoicesResponse | undefined;
  readonly filter: OwnFilter;
  readonly onFilter: (filter: OwnFilter) => void;
}) {
  const { t } = useLingui();
  const q = useDebounced(filter.text.trim());
  const own = useInfiniteQuery(ownVoicesQuery(account, q, filter.visibility));

  if (overview !== undefined && overview.status !== "ok") {
    return <KeyProblem status={overview.status} />;
  }
  // Nothing to search until the account has a voice.
  if (overview?.items.length === 0) {
    return (
      <EmptyState
        icon={<AudioLinesIcon />}
        title={t`No voices of your own yet`}
        description={t`Voices you make on Fish Audio show up here, private ones included.`}
        action={
          <Button variant="outline" size="sm" asChild>
            <a href={CREATE_VOICE_URL} target="_blank" rel="noreferrer noopener">
              {t`Create a Voice on Fish Audio`}
              <ExternalLinkIcon />
            </a>
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SearchRow
        label={t`Search Your Voices`}
        placeholder={t`Search by name`}
        text={filter.text}
        onText={(text) => onFilter({ ...filter, text })}
        fetching={own.isFetching}
        disabled={list.disabled}
      >
        <Select
          value={filter.visibility || ALL}
          onValueChange={(next) =>
            onFilter({
              ...filter,
              visibility: VISIBILITY_FILTERS.find((visibility) => visibility === next) ?? "",
            })
          }
          disabled={list.disabled}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label={t`Visibility`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VISIBILITY_FILTERS.map((visibility) => (
              <SelectItem key={visibility || ALL} value={visibility || ALL}>
                {t(VISIBILITY_LABELS[visibility])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SearchRow>
      <p className="text-muted-foreground text-xs">{t`Voices you made on Fish Audio, private ones included, newest first.`}</p>
      <VoiceResults {...list} query={own} owned />
    </div>
  );
}
