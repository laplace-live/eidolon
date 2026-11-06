// Amounts, sizes, counts and times, written for the viewer's language.
import type { Lang } from "@/lib/i18n";

const formats = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

/** Building an Intl formatter costs far more than using one, and a job's log formats hundreds. */
function cached<F extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => F): F {
  let format = formats.get(key) as F | undefined;
  if (format === undefined) {
    format = make();
    formats.set(key, format);
  }
  return format;
}

/** US dollars to the cent; an amount under a cent shows as such rather than as $0.00. */
export function formatUsd(usd: number, lang: Lang): string {
  const format = cached(
    `usd:${lang}`,
    () => new Intl.NumberFormat(lang, { style: "currency", currency: "USD" }),
  );
  if (usd > 0 && usd < 0.01) return `< ${format.format(0.01)}`;
  return format.format(usd);
}

/** `1:02:03`, or `4:05` under an hour. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** Decimal units, as disk utilities report free space. */
export function formatBytes(bytes: number, lang: Lang): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < BYTE_UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const format = cached(
    `bytes:${lang}:${unit}`,
    () =>
      new Intl.NumberFormat(lang, {
        style: "unit",
        unit: BYTE_UNITS[unit],
        maximumFractionDigits: unit === 0 ? 0 : 1,
      }),
  );
  return format.format(value);
}

export function formatCount(count: number, lang: Lang): string {
  return cached(`count:${lang}`, () => new Intl.NumberFormat(lang)).format(count);
}

/** A date and time in the viewer's locale and time zone. */
export function formatDateTime(iso: string, lang: Lang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const format = cached(
    `datetime:${lang}`,
    () => new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }),
  );
  return format.format(date);
}

/** As toLocaleTimeString(lang, {hour12: false}) writes it. */
export function formatClock(ms: number, lang: Lang): string {
  const format = cached(
    `clock:${lang}`,
    () =>
      new Intl.DateTimeFormat(lang, {
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
        hour12: false,
      }),
  );
  return format.format(ms);
}

/** Seconds from `start` to `end`, or to `now` while it runs. */
export function elapsedSeconds(start: string, end: string | null, now: number): number {
  const from = Date.parse(start);
  const to = end === null ? now : Date.parse(end);
  return Number.isNaN(from) || Number.isNaN(to) ? 0 : Math.max(0, (to - from) / 1000);
}
