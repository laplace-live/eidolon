// The usage page's tables: spend by provider, by model and by persona, the costliest first.

import { ph, plural, t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PersonaSummary } from "@/lib/api";
import { cached, formatCompact, formatCount, formatSpend } from "@/lib/format";
import { ROLE_LABELS } from "@/lib/labels";
import { providerName, type RoleId } from "@/lib/providers";
import { cn } from "@/lib/utils";
import { type Lang, useLang } from "@/locales/i18n";
import { seriesColor } from "./spend-chart";
import { type Group, type ModelKey, OTHER, type Totals } from "./summary";

/** What a line used, in the units its provider bills: tokens, characters, audio, images. */
export function unitsText(lang: Lang, totals: Totals): string {
  const parts: string[] = [];
  const input = totals.inputTokens;
  if (totals.outputTokens > 0) {
    parts.push(
      t`${ph({ input: formatCompact(input, lang) })} tokens in · ${ph({ output: formatCompact(totals.outputTokens, lang) })} out`,
    );
  } else if (input > 0) {
    const amount = formatCompact(input, lang);
    parts.push(
      t`${plural(ph({ count: input }), { one: `${amount} token`, other: `${amount} tokens` })}`,
    );
  }
  if (totals.characters > 0) {
    const amount = formatCompact(totals.characters, lang);
    parts.push(
      t`${plural(ph({ count: totals.characters }), { one: `${amount} character`, other: `${amount} characters` })}`,
    );
  }
  if (totals.audioSeconds > 0) {
    const minutes = totals.audioSeconds / 60;
    const digits = minutes < 10 ? 1 : 0;
    const amount = cached(
      `minutes:${lang}:${digits}`,
      () => new Intl.NumberFormat(lang, { maximumFractionDigits: digits }),
    ).format(minutes);
    parts.push(t`${amount} min of audio`);
  }
  if (totals.images > 0)
    parts.push(t`${plural(ph({ count: totals.images }), { one: `# image`, other: `# images` })}`);
  return parts.join(" · ");
}

export function roleLabel(role: string): string {
  const label = ROLE_LABELS[role as RoleId];
  return label === undefined ? role : t(label);
}

/** Spend, marked ≈ where any of it is the catalog's estimate rather than the provider's figure. */
export function Spend({ totals }: { readonly totals: Totals }) {
  const { t } = useLingui();
  const lang = useLang();
  const estimated = totals.estimatedUsd > 0;
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span
        className="font-medium tabular-nums"
        title={
          estimated
            ? t`${ph({ amount: formatSpend(totals.estimatedUsd, lang) })} of it is estimated from list prices.`
            : undefined
        }
      >
        {estimated && <span className="mr-0.5 text-muted-foreground">≈</span>}
        {formatSpend(totals.costUsd, lang)}
      </span>
      {totals.unpriced > 0 && (
        <span className="text-muted-foreground text-xs">
          {t`${ph({ count: totals.unpriced })} unpriced`}
        </span>
      )}
    </span>
  );
}

function Frame({
  head,
  children,
}: {
  /** Each column's label, right-aligned when `end`; `className` hides one on a narrow screen. */
  readonly head: readonly {
    readonly label: string;
    readonly end?: boolean;
    readonly className?: string;
  }[];
  readonly children: ReactNode;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {head.map((column) => (
            <TableHead
              key={column.label}
              className={cn(column.end && "text-right", column.className)}
            >
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

/** Columns a phone leaves out, so a row's spend stays on screen. */
const NOT_PHONE = "hidden sm:table-cell";
const WIDE = "hidden md:table-cell";

function share(part: number, whole: number, lang: Lang): string {
  const format = cached(
    `percent:${lang}`,
    () => new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }),
  );
  return format.format(whole > 0 ? part / whole : 0);
}

export function ProviderTable({
  groups,
  slots,
  total,
}: {
  readonly groups: readonly Group<string>[];
  readonly slots: ReadonlyMap<string, number | typeof OTHER>;
  readonly total: number;
}) {
  const { t } = useLingui();
  const lang = useLang();
  return (
    <Frame
      head={[
        { label: t`Provider` },
        { label: t`Usage`, className: WIDE },
        { label: t`Requests`, end: true },
        { label: t`Share`, end: true, className: NOT_PHONE },
        { label: t`Spend`, end: true },
      ]}
    >
      {groups.map(({ key, totals }) => (
        <TableRow key={key}>
          <TableCell>
            <span className="flex items-center gap-2 font-medium">
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ background: seriesColor({ slot: slots.get(key) ?? OTHER }) }}
              />
              {providerName(key)}
            </span>
          </TableCell>
          <TableCell className={cn("text-muted-foreground", WIDE)}>
            {unitsText(lang, totals)}
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {formatCount(totals.records, lang)}
          </TableCell>
          <TableCell className={cn("text-right text-muted-foreground tabular-nums", NOT_PHONE)}>
            {share(totals.costUsd, total, lang)}
          </TableCell>
          <TableCell className="text-right">
            <Spend totals={totals} />
          </TableCell>
        </TableRow>
      ))}
    </Frame>
  );
}

export function ModelTable({ groups }: { readonly groups: readonly Group<ModelKey>[] }) {
  const { t } = useLingui();
  const lang = useLang();
  return (
    <Frame
      head={[
        { label: t`Model` },
        { label: t`Task`, className: NOT_PHONE },
        { label: t`Usage`, className: WIDE },
        { label: t`Spend`, end: true },
      ]}
    >
      {groups.map(({ key, totals }) => (
        <TableRow key={`${key.provider}\n${key.role}\n${key.model}`}>
          <TableCell className="max-w-72 whitespace-normal">
            <span className="flex flex-col gap-0.5">
              <code className="break-all font-mono text-[0.8125rem]">{key.model}</code>
              <span className="text-muted-foreground text-xs">
                {providerName(key.provider)}
                {/* A phone has no room for the task's own column. */}
                <span className="sm:hidden">
                  {t({ message: `, `, context: "list separator" })}
                  {roleLabel(key.role)}
                </span>
              </span>
            </span>
          </TableCell>
          <TableCell className={NOT_PHONE}>{roleLabel(key.role)}</TableCell>
          <TableCell className={cn("text-muted-foreground", WIDE)}>
            {unitsText(lang, totals)}
          </TableCell>
          <TableCell className="text-right">
            <Spend totals={totals} />
          </TableCell>
        </TableRow>
      ))}
    </Frame>
  );
}

export function PersonaTable({
  groups,
  personas,
}: {
  readonly groups: readonly Group<string>[];
  readonly personas: readonly PersonaSummary[];
}) {
  const { t } = useLingui();
  const lang = useLang();
  return (
    <Frame
      head={[
        { label: t`Persona` },
        { label: t`Requests`, end: true },
        { label: t`Spend`, end: true },
      ]}
    >
      {groups.map(({ key, totals }) => (
        <TableRow key={key}>
          <TableCell className="font-medium">
            {personas.find((persona) => persona.id === key)?.name ?? key}
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {formatCount(totals.records, lang)}
          </TableCell>
          <TableCell className="text-right">
            <Spend totals={totals} />
          </TableCell>
        </TableRow>
      ))}
    </Frame>
  );
}
