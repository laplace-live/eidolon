// /usage: what each provider has cost, as the usage ledger on this machine recorded it, for one
// persona or all of them. Filters live in the URL, so a persona's studio can link to hers.

import { msg, ph, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChartColumnIcon, CircleAlertIcon, ReceiptIcon, TableIcon } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { EmptyState } from "@/components/empty-state";
import { ErrorAlert } from "@/components/error-alert";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { personasQuery } from "@/components/settings-form/queries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { call, type PersonaSummary } from "@/lib/api";
import { formatSpend } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLang } from "@/locales/i18n";
import { ChartLegend, SpendChart, SpendTable, seriesLabel } from "./spend-chart";
import {
  bucketsOf,
  byModel,
  byPersona,
  byProvider,
  chartOf,
  isRange,
  RANGES,
  type RangeId,
  rangeStart,
  seriesSlots,
  totalsOf,
} from "./summary";
import { ModelTable, PersonaTable, ProviderTable } from "./tables";

const ALL = "all";

const RANGE_LABELS = {
  "7d": msg`7 Days`,
  "30d": msg`30 Days`,
  "90d": msg`90 Days`,
  "12m": msg`12 Months`,
  all: msg`All Time`,
} satisfies Record<RangeId, unknown>;

/** Each range as the end of a sentence: "Spent by all personas in the last 7 days". */
const DURING = {
  "7d": msg`in the last 7 days`,
  "30d": msg`in the last 30 days`,
  "90d": msg`in the last 90 days`,
  "12m": msg`in the last 12 months`,
  all: msg`since recording began`,
} satisfies Record<RangeId, unknown>;

function usageQuery(persona: string | null, from: number | undefined) {
  return {
    queryKey: ["usage", persona, from ?? null],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      call("GET /api/local/usage", { query: { persona: persona ?? undefined, from }, signal }),
    placeholderData: keepPreviousData,
  };
}

function Filters({
  persona,
  range,
  personas,
  onChange,
}: {
  readonly persona: string | null;
  readonly range: RangeId;
  readonly personas: readonly { readonly id: string; readonly name: string }[];
  readonly onChange: (next: { persona?: string | null; range?: RangeId }) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        value={range}
        onValueChange={(value) => isRange(value) && onChange({ range: value })}
        aria-label={t`Range`}
      >
        {RANGES.map((id) => (
          <ToggleGroupItem key={id} value={id} className="px-3">
            {t(RANGE_LABELS[id])}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Select
        value={persona ?? ALL}
        onValueChange={(value) => onChange({ persona: value === ALL ? null : value })}
      >
        <SelectTrigger className="w-52" aria-label={t`Persona`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t`All Personas`}</SelectItem>
          {personas.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Ledger personas by name, those with a folder first; one whose folder is gone shows her id. */
function personaChoices(ids: readonly string[], known: readonly PersonaSummary[]) {
  const named = known.map((persona) => ({ id: persona.id, name: persona.name }));
  const gone = ids
    .filter((id) => !known.some((persona) => persona.id === id))
    .map((id) => ({ id, name: id }));
  return [...named, ...gone];
}

export function Component() {
  const { t } = useLingui();
  const lang = useLang();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<"chart" | "table">("chart");
  const rangeParam = params.get("range");
  const range: RangeId = isRange(rangeParam) ? rangeParam : "30d";
  const persona = params.get("persona") || null;
  // Stable all day: the range starts at a local midnight.
  const now = new Date();
  const from = rangeStart(range, now);
  const usage = useQuery(usageQuery(persona, from));
  const personas = useQuery(personasQuery).data?.personas ?? [];

  function onChange(next: { persona?: string | null; range?: RangeId }) {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next.range !== undefined) updated.set("range", next.range);
        if (next.persona !== undefined) {
          if (next.persona === null) updated.delete("persona");
          else updated.set("persona", next.persona);
        }
        return updated;
      },
      { replace: true },
    );
  }

  const summary = usage.data;
  const rows = summary?.rows ?? [];
  const totals = totalsOf(rows);
  const slots = seriesSlots(summary?.providers ?? []);
  const { granularity, buckets } = bucketsOf(range, rows, now);
  const { series, columns } = chartOf(rows, buckets, granularity, slots);
  const choices = personaChoices(summary?.personas ?? [], personas);
  const personaName = choices.find((choice) => choice.id === persona)?.name ?? persona;
  const during = t(DURING[range]);
  const scope =
    persona === null
      ? t`Spent by all personas ${during}`
      : t`Spent by ${ph({ name: personaName ?? "" })} ${during}`;
  const refetching = usage.isFetching && usage.isPlaceholderData;
  const chartTitle = granularity === "month" ? t`Spend per month` : t`Spend per day`;
  const path = summary?.path ?? "";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t`Usage`}
        description={t`What each provider has cost, as calls, video jobs and MCP searches on this machine recorded it.`}
      />
      <Filters persona={persona} range={range} personas={choices} onChange={onChange} />
      {usage.isError && <ErrorAlert error={usage.error} />}
      {summary?.recording === false && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{t`Usage isn't being recorded`}</AlertTitle>
          <AlertDescription>
            <Trans>
              Eidolon can't write its usage ledger at <code className="font-mono">{path}</code>. Set{" "}
              <code className="font-mono">EIDOLON_USAGE_DB</code> to a file it can write, then
              restart.
            </Trans>
          </AlertDescription>
        </Alert>
      )}
      {usage.isPending ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-16 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : summary === undefined ? null : rows.length === 0 ? (
        <EmptyState
          icon={<ReceiptIcon />}
          title={t`Nothing recorded`}
          description={t`No spending was recorded ${during}. Calls, video jobs and MCP searches record theirs here as they run.`}
        />
      ) : (
        <div
          className={cn(
            "flex flex-col gap-8 transition-opacity",
            refetching && "pointer-events-none opacity-60",
          )}
          aria-busy={refetching}
        >
          <section aria-labelledby="usage-total" className="flex flex-col gap-1">
            <h2 id="usage-total" className="text-muted-foreground text-sm">
              {scope}
            </h2>
            <p className="font-semibold text-5xl tracking-tight">
              {totals.estimatedUsd > 0 && <span className="mr-1 text-muted-foreground">≈</span>}
              {formatSpend(totals.costUsd, lang)}
            </p>
            <p className="text-muted-foreground text-sm">
              {totals.estimatedUsd > 0
                ? t`${ph({ amount: formatSpend(totals.estimatedUsd, lang) })} of it is estimated from list prices.`
                : totals.costUsd > 0
                  ? t`As each provider reported it.`
                  : ""}
              {totals.unpriced > 0 &&
                ` ${t`${plural(ph({ count: totals.unpriced }), { one: `# request has no price, so it isn't counted.`, other: `# requests have no price, so they aren't counted.` })}`}`}
            </p>
          </section>
          <SectionCard
            title={chartTitle}
            description={
              series.length === 1 && series[0]
                ? seriesLabel(series[0], t`Other`)
                : t`Stacked by provider.`
            }
            action={
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                value={view}
                onValueChange={(value) =>
                  (value === "chart" || value === "table") && setView(value)
                }
                aria-label={t`View`}
              >
                <ToggleGroupItem value="chart" aria-label={t`Chart`}>
                  <ChartColumnIcon />
                </ToggleGroupItem>
                <ToggleGroupItem value="table" aria-label={t`Table`}>
                  <TableIcon />
                </ToggleGroupItem>
              </ToggleGroup>
            }
          >
            {view === "chart" ? (
              <div className="flex flex-col gap-4">
                {series.length > 1 && <ChartLegend series={series} />}
                <SpendChart
                  columns={columns}
                  series={series}
                  granularity={granularity}
                  label={`${chartTitle}, ${scope}`}
                />
              </div>
            ) : (
              <SpendTable columns={columns} series={series} granularity={granularity} />
            )}
          </SectionCard>
          <SectionCard
            title={t`By Provider`}
            description={t`Spend and usage per provider, the costliest first.`}
          >
            <ProviderTable groups={byProvider(rows)} slots={slots} total={totals.costUsd} />
          </SectionCard>
          <SectionCard
            title={t`By Model`}
            description={t`Each model, and the task it did for her.`}
          >
            <ModelTable groups={byModel(rows)} />
          </SectionCard>
          {persona === null && new Set(rows.map((row) => row.persona)).size > 1 && (
            <SectionCard title={t`By Persona`}>
              <PersonaTable groups={byPersona(rows)} personas={personas} />
            </SectionCard>
          )}
          <p className="text-muted-foreground text-xs">
            <Trans>
              Estimates use each model's list price, promotions included; your provider's bill is
              the final word. Recorded in <code className="break-all font-mono">{path}</code>.
            </Trans>
          </p>
        </div>
      )}
    </div>
  );
}
