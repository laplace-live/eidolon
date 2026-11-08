// Spend over time as stacked columns, one series per provider. Plain SVG: the marks follow the
// data-viz specs (thin columns, a 2px surface gap between segments, a rounded data end), and every
// value the tooltip shows is also in the table view.

import { useLingui } from "@lingui/react/macro";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { cached, formatSpend, formatUsdTick } from "@/lib/format";
import { providerName } from "@/lib/providers";
import { type Lang, useLang } from "@/locales/i18n";
import {
  type Column,
  type Granularity,
  niceTicks,
  OTHER,
  type Series,
  stepDecimals,
} from "./summary";

const PLOT_HEIGHT = 192;
const TOP = 8;
const AXIS_BAND = 28;
const LEFT = 64;
const RIGHT = 8;
const GAP = 2;
const RADIUS = 4;
const MAX_BAR = 24;
const LABEL_SPACING = 72;

export function seriesColor(series: Pick<Series, "slot">): string {
  return series.slot === OTHER ? "var(--series-other)" : `var(--series-${series.slot})`;
}

export function seriesLabel(series: Pick<Series, "id">, other: string): string {
  return series.id === OTHER ? other : providerName(series.id);
}

/** A column's date: short under its axis tick, long in its readout. */
export function columnDate(
  column: Pick<Column, "start">,
  granularity: Granularity,
  lang: Lang,
  long = false,
): string {
  const format = cached(`column:${lang}:${granularity}:${long}`, () => {
    const options: Intl.DateTimeFormatOptions =
      granularity === "month"
        ? { year: "numeric", month: long ? "long" : "short" }
        : long
          ? { dateStyle: "medium" }
          : { month: "short", day: "numeric" };
    return new Intl.DateTimeFormat(lang, options);
  });
  return format.format(column.start);
}

/** A rectangle with its top corners rounded, square at the baseline. */
function roundedTop(x: number, y: number, width: number, height: number): string {
  const r = Math.min(RADIUS, width / 2, height);
  return `M${x},${y + height}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + width - r}A${r},${r} 0 0 1 ${x + width},${y + r}V${y + height}Z`;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function ChartLegend({ series }: { readonly series: readonly Series[] }) {
  const { t } = useLingui();
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-muted-foreground text-sm">
      {series.map((entry) => (
        <li key={entry.id} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-[3px]"
            style={{ background: seriesColor(entry) }}
          />
          {seriesLabel(entry, t`Other`)}
        </li>
      ))}
    </ul>
  );
}

function Readout({
  column,
  series,
  granularity,
}: {
  readonly column: Column;
  readonly series: readonly Series[];
  readonly granularity: Granularity;
}) {
  const { t } = useLingui();
  const lang = useLang();
  return (
    <>
      <div className="text-muted-foreground">{columnDate(column, granularity, lang, true)}</div>
      <div className="font-semibold text-sm tabular-nums">{formatSpend(column.total, lang)}</div>
      {series.length > 1 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {[...series].reverse().map((entry) => (
            <li key={entry.id} className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-0.5 w-3 shrink-0 rounded-full"
                style={{ background: seriesColor(entry) }}
              />
              <span className="font-medium tabular-nums">
                {formatSpend(column.values[entry.id] ?? 0, lang)}
              </span>
              <span className="text-muted-foreground">{seriesLabel(entry, t`Other`)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export interface SpendChartProps {
  readonly columns: readonly Column[];
  /** Bottom to top. */
  readonly series: readonly Series[];
  readonly granularity: Granularity;
  /** The chart's accessible name. */
  readonly label: string;
}

export function SpendChart({ columns, series, granularity, label }: SpendChartProps) {
  const { t } = useLingui();
  const lang = useLang();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const max = columns.reduce((top, column) => Math.max(top, column.total), 0);
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? 0;
  const step = ticks[1] ?? 0;
  const decimals = step >= 1 ? 0 : Math.max(2, stepDecimals(step));
  const plotWidth = Math.max(0, width - LEFT - RIGHT);
  const band = columns.length > 0 ? plotWidth / columns.length : 0;
  const bar = Math.max(1, Math.min(MAX_BAR, band * 0.64));
  const baseline = TOP + PLOT_HEIGHT;
  const height = baseline + AXIS_BAND;
  const scale = (value: number): number => (top > 0 ? (value / top) * PLOT_HEIGHT : 0);
  const labelEvery = Math.max(
    1,
    Math.ceil(columns.length / Math.max(2, plotWidth / LABEL_SPACING)),
  );
  const shown = active === null ? undefined : columns[active];
  const current = columns[active ?? columns.length - 1];
  // A slider: arrow keys walk the columns as the pointer does, and the reader hears each readout.
  const valueText =
    current === undefined
      ? ""
      : [
          columnDate(current, granularity, lang, true),
          formatSpend(current.total, lang),
          ...series.map(
            (entry) =>
              `${seriesLabel(entry, t`Other`)} ${formatSpend(current.values[entry.id] ?? 0, lang)}`,
          ),
        ].join(t({ message: `, `, context: "list separator" }));

  function onKeyDown(event: KeyboardEvent) {
    const last = columns.length - 1;
    const current = active ?? last;
    const next =
      event.key === "ArrowLeft"
        ? Math.max(0, current - 1)
        : event.key === "ArrowRight"
          ? Math.min(last, current + 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  const center = (index: number): number => LEFT + index * band + band / 2;
  const tooltipOnRight = active !== null && center(active) < width / 2;

  return (
    <div
      ref={ref}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, columns.length - 1)}
      aria-valuenow={active ?? Math.max(0, columns.length - 1)}
      aria-valuetext={valueText}
      tabIndex={0}
      className="relative rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      style={{ height }}
      onKeyDown={onKeyDown}
      onFocus={() => setActive((current) => current ?? Math.max(0, columns.length - 1))}
      onBlur={() => setActive(null)}
      // A tap leaves at once on touch, so its readout stays until the next tap or a blur.
      onPointerLeave={(event) => event.pointerType !== "touch" && setActive(null)}
    >
      {width > 0 && (
        <svg width={width} height={height} aria-hidden className="block overflow-visible">
          {ticks.map((tick) => {
            const y = baseline - scale(tick);
            return (
              <g key={tick}>
                <line
                  x1={LEFT}
                  x2={width - RIGHT}
                  y1={y}
                  y2={y}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                  style={{
                    stroke: tick === 0 ? "var(--muted-foreground)" : "var(--border)",
                    strokeOpacity: tick === 0 ? 0.4 : 1,
                  }}
                />
                <text
                  x={LEFT - 8}
                  y={y}
                  dy="0.32em"
                  textAnchor="end"
                  className="text-xs tabular-nums"
                  style={{ fill: "var(--muted-foreground)" }}
                >
                  {formatUsdTick(tick, decimals, lang)}
                </text>
              </g>
            );
          })}
          {active !== null && (
            <rect
              x={LEFT + active * band}
              y={TOP}
              width={band}
              height={PLOT_HEIGHT}
              rx={Math.min(RADIUS, band / 4)}
              style={{ fill: "var(--muted)" }}
            />
          )}
          {columns.map((column, index) => {
            const x = LEFT + index * band + (band - bar) / 2;
            const drawn = series.filter((entry) => (column.values[entry.id] ?? 0) > 0);
            let y = baseline;
            return (
              <g key={column.key}>
                {drawn.map((entry, position) => {
                  const h = scale(column.values[entry.id] ?? 0);
                  y -= h;
                  const color = seriesColor(entry);
                  if (position === drawn.length - 1) {
                    return (
                      <path key={entry.id} d={roundedTop(x, y, bar, h)} style={{ fill: color }} />
                    );
                  }
                  // The gap to the segment above is cut from this one's top, so totals stay true.
                  const visible = h - GAP;
                  return visible > 0 ? (
                    <rect
                      key={entry.id}
                      x={x}
                      y={y + GAP}
                      width={bar}
                      height={visible}
                      style={{ fill: color }}
                    />
                  ) : null;
                })}
              </g>
            );
          })}
          {columns.map((column, index) => {
            if ((columns.length - 1 - index) % labelEvery !== 0) return null;
            const x = center(index);
            const anchor =
              x - LABEL_SPACING / 2 < LEFT
                ? "start"
                : x + LABEL_SPACING / 2 > width
                  ? "end"
                  : "middle";
            return (
              <text
                key={column.key}
                x={anchor === "start" ? LEFT + index * band : anchor === "end" ? width - RIGHT : x}
                y={baseline + 18}
                textAnchor={anchor}
                className="text-xs"
                style={{ fill: "var(--muted-foreground)" }}
              >
                {columnDate(column, granularity, lang)}
              </text>
            );
          })}
          {columns.map((column, index) => (
            <rect
              key={column.key}
              x={LEFT + index * band}
              y={TOP}
              width={band}
              height={PLOT_HEIGHT + AXIS_BAND}
              fill="transparent"
              onPointerEnter={() => setActive(index)}
              onPointerDown={() => setActive(index)}
            />
          ))}
        </svg>
      )}
      {shown !== undefined && active !== null && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 min-w-36 rounded-md border bg-popover px-3 py-2 text-popover-foreground text-xs shadow-md"
          style={
            tooltipOnRight
              ? { left: center(active) + band / 2 + 8, top: TOP }
              : { right: width - center(active) + band / 2 + 8, top: TOP }
          }
        >
          <Readout column={shown} series={series} granularity={granularity} />
        </div>
      )}
    </div>
  );
}

/** The chart's table twin: each column that spent anything, newest first. */
export function SpendTable({ columns, series, granularity }: Omit<SpendChartProps, "label">) {
  const { t } = useLingui();
  const lang = useLang();
  const spent = columns.filter((column) => column.total > 0).reverse();
  if (spent.length === 0) {
    return <p className="text-muted-foreground text-sm">{t`Nothing was spent in this range.`}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-medium">
              {granularity === "month" ? t`Month` : t`Day`}
            </th>
            {series.map((entry) => (
              <th key={entry.id} scope="col" className="py-2 pr-4 text-right font-medium">
                {seriesLabel(entry, t`Other`)}
              </th>
            ))}
            <th scope="col" className="py-2 text-right font-medium">
              {t`Total`}
            </th>
          </tr>
        </thead>
        <tbody>
          {spent.map((column) => (
            <tr key={column.key} className="border-b last:border-0">
              <th scope="row" className="py-2 pr-4 text-left font-normal">
                {columnDate(column, granularity, lang, true)}
              </th>
              {series.map((entry) => (
                <td key={entry.id} className="py-2 pr-4 text-right tabular-nums">
                  {formatSpend(column.values[entry.id] ?? 0, lang)}
                </td>
              ))}
              <td className="py-2 text-right font-medium tabular-nums">
                {formatSpend(column.total, lang)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
