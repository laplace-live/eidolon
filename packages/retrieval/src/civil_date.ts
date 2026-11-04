// Python `datetime.date` on "YYYY-MM-DD" strings: proleptic Gregorian, years 1..9999. Integer day
// ordinals, because JS Date maps years below 100 to 19xx.
import { daysInMonth, ordinalToYmd, pyRepr, ymdToOrdinal, zonedClock } from "@eidolon/config";

export type IsoDate = string;

/** Python's ValueError / OverflowError from date construction or arithmetic. */
export class DateRangeError extends RangeError {}

const MAX_ORDINAL = 3652059;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function check(year: number, month: number, day: number): void {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new DateRangeError(`year ${year} is out of range`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new DateRangeError("month must be in 1..12");
  }
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new DateRangeError("day is out of range for month");
  }
}

function format(year: number, month: number, day: number): IsoDate {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

function parts(text: string): [number, number, number] {
  const m = ISO.exec(text);
  if (!m) throw new DateRangeError(`Invalid isoformat string: ${pyRepr(text)}`);
  const ymd: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  check(...ymd);
  return ymd;
}

function toOrdinal(text: IsoDate): number {
  return ymdToOrdinal(...parts(text));
}

function fromOrdinal(ordinal: number): IsoDate {
  if (ordinal < 1 || ordinal > MAX_ORDINAL) throw new DateRangeError("date value out of range");
  return format(...ordinalToYmd(ordinal));
}

/** `date(year, month, day).isoformat()`. */
export function isoDate(year: number, month: number, day: number): IsoDate {
  check(year, month, day);
  return format(year, month, day);
}

/** Strict `YYYY-MM-DD` naming a real date in years 1..9999. */
export function isValidIsoDate(text: string): boolean {
  try {
    parts(text);
    return true;
  } catch {
    return false;
  }
}

export function parseIsoDate(text: string): IsoDate {
  parts(text);
  return text;
}

/** `date + timedelta(days=n)`. */
export function addDays(date: IsoDate, n: number): IsoDate {
  return fromOrdinal(toOrdinal(date) + n);
}

/** Monday is 0. */
export function weekday(date: IsoDate): number {
  return (toOrdinal(date) + 6) % 7;
}

export function firstOfMonth(date: IsoDate): IsoDate {
  const [year, month] = parts(date);
  return format(year, month, 1);
}

/** `(d.replace(day=28) + timedelta(days=4)).replace(day=1)`, overflowing past 9999-12. */
export function firstOfNextMonth(date: IsoDate): IsoDate {
  const [year, month] = parts(date);
  return firstOfMonth(addDays(format(year, month, 28), 4));
}

/** Whole calendar days from `from` to `to`: Python `(to - from).days`, negative when `to` is earlier. */
export function diffDays(from: IsoDate, to: IsoDate): number {
  return toOrdinal(to) - toOrdinal(from);
}

export function yearOf(date: IsoDate): number {
  return parts(date)[0];
}

/** Today's date in `timeZone`, via config's zonedClock. */
export function todayIn(timeZone: string, now?: Date): IsoDate {
  return zonedClock(timeZone, now).isoDate;
}
