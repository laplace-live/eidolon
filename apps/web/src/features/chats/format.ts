// The chat list's times and names, written for the viewer's language.
import { cached } from "@/lib/format";
import type { Lang } from "@/locales/i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "5 min. ago", "yesterday"; past a week, the date. */
export function relativeTime(at: number, now: number, lang: Lang): string {
  const ago = Math.max(0, now - at);
  if (ago >= 7 * DAY) return shortDate(at, lang, now);
  const format = cached(
    `chatRelative:${lang}`,
    () => new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" }),
  );
  if (ago < MINUTE) return format.format(0, "second");
  if (ago < HOUR) return format.format(-Math.floor(ago / MINUTE), "minute");
  if (ago < DAY) return format.format(-Math.floor(ago / HOUR), "hour");
  return format.format(-Math.floor(ago / DAY), "day");
}

/** The month and day, with the year only when it isn't this one. */
export function shortDate(at: number, lang: Lang, now: number): string {
  const thisYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const format = cached(
    `chatDate:${lang}:${thisYear}`,
    () =>
      new Intl.DateTimeFormat(lang, {
        month: "short",
        day: "numeric",
        year: thisYear ? undefined : "numeric",
      }),
  );
  return format.format(at);
}

/** A chat's name: its title, else who it is with and the day it started. */
export function chatName(
  title: string | null,
  persona: string,
  createdAt: number,
  lang: Lang,
  now: number,
): string {
  return title ?? `${persona} · ${shortDate(createdAt, lang, now)}`;
}
