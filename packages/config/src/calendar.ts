// CPython datetime's proleptic Gregorian day numbers: ordinal 1 is 0001-01-01. Integer ordinals,
// because JS Date maps years below 100 to 19xx. Nothing here range-checks its arguments.

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
const DAYS_IN_400Y = 146_097;
const DAYS_IN_100Y = 36_524;
const DAYS_IN_4Y = 1461;

export function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeap(year) ? 29 : (DAYS_IN_MONTH[month] as number);
}

/** `_ymd2ord`: `date(year, month, day).toordinal()`. */
export function ymdToOrdinal(year: number, month: number, day: number): number {
  const y = year - 1;
  const leapDay = month > 2 && isLeap(year) ? 1 : 0;
  return (
    y * 365 +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) +
    (DAYS_BEFORE_MONTH[month] as number) +
    leapDay +
    day
  );
}

/** `_ord2ymd`: `date.fromordinal(n)` as `[year, month, day]`, for n >= 1. */
export function ordinalToYmd(n: number): [number, number, number] {
  let rest = n - 1;
  const n400 = Math.floor(rest / DAYS_IN_400Y);
  rest %= DAYS_IN_400Y;
  const n100 = Math.floor(rest / DAYS_IN_100Y);
  rest %= DAYS_IN_100Y;
  const n4 = Math.floor(rest / DAYS_IN_4Y);
  rest %= DAYS_IN_4Y;
  const n1 = Math.floor(rest / 365);
  rest %= 365;
  const year = n400 * 400 + 1 + n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return [year - 1, 12, 31];
  let month = (rest + 50) >> 5;
  let preceding = (DAYS_BEFORE_MONTH[month] as number) + (month > 2 && isLeap(year) ? 1 : 0);
  if (preceding > rest) {
    month -= 1;
    preceding -= daysInMonth(year, month);
  }
  return [year, month, rest - preceding + 1];
}
