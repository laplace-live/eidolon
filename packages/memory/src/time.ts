// mem0 stamps every record with `datetime.now(timezone.utc).isoformat()` and the greeting sorts
// by `datetime.fromisoformat`, so both are reproduced here: microsecond resolution (records built
// in one add get distinct, increasing stamps, which decides the greeting's order) and CPython's C
// parser, which is laxer than its pure-Python twin (it skips a stray character before an offset).
import {
  daysInMonth,
  isLeap,
  ordinalToYmd,
  pyError,
  pyStrRepr,
  pyTruthy,
  ymdToOrdinal,
} from "@eidolon/config";

/** Microseconds since the Unix epoch. */
export type Clock = () => number;

let offsetMicros: number | null = null;

/**
 * Wall-clock microseconds. `Date.now()` alone has millisecond resolution; the monotonic clock
 * supplies the rest, re-anchored whenever the two drift a millisecond apart (sleep, clock steps).
 */
export const wallClockMicros: Clock = () => {
  const mono = performance.now() * 1000;
  const wall = Date.now() * 1000;
  if (offsetMicros === null || Math.abs(mono + offsetMicros - wall) >= 1000) {
    offsetMicros = wall - mono;
  }
  return Math.floor(mono + offsetMicros);
};

const MICROS_PER_DAY = 86_400_000_000n;
const EPOCH_ORDINAL = 719_163; // date(1970, 1, 1).toordinal()

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  micro: number;
}

function partsFromMicros(epochMicros: bigint): Parts {
  let days = epochMicros / MICROS_PER_DAY;
  let rest = epochMicros % MICROS_PER_DAY;
  if (rest < 0n) {
    rest += MICROS_PER_DAY;
    days -= 1n;
  }
  const [year, month, day] = ordinalToYmd(Number(days) + EPOCH_ORDINAL);
  const micros = Number(rest);
  return {
    year,
    month,
    day,
    hour: Math.floor(micros / 3_600_000_000),
    minute: Math.floor(micros / 60_000_000) % 60,
    second: Math.floor(micros / 1_000_000) % 60,
    micro: micros % 1_000_000,
  };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function isoDate(p: { year: number; month: number; day: number }): string {
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
}

function isoUtc(p: Parts): string {
  const time = `${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}`;
  const fraction = p.micro === 0 ? "" : `.${pad(p.micro, 6)}`;
  return `${isoDate(p)}T${time}${fraction}+00:00`;
}

/** `datetime.now(timezone.utc).isoformat()` at this instant; the fraction is omitted when zero. */
export function pyIsoformatUtc(epochMicros: number): string {
  return isoUtc(partsFromMicros(BigInt(epochMicros)));
}

/** `datetime.now(timezone.utc).date().isoformat()` at this instant. */
export function utcIsoDate(epochMicros: number): string {
  return isoDate(partsFromMicros(BigInt(epochMicros)));
}

/** `[year, month, day]` of the UTC date at this instant. */
export function utcDateParts(epochMicros: number): [number, number, number] {
  const p = partsFromMicros(BigInt(epochMicros));
  return [p.year, p.month, p.day];
}

/** A parsed `datetime`: aware ones carry their UTC instant, naive ones their wall time as if UTC. */
export interface PyDatetime {
  readonly micros: bigint;
  readonly aware: boolean;
}

const ZERO = 0x30;
const DASH = 0x2d;
const COLON = 0x3a;
const WEEK = 0x57; // "W"
const ZULU = 0x5a; // "Z"

function isDigit(b: number): boolean {
  return b >= ZERO && b <= ZERO + 9;
}

/** UTF-8 bytes read the way the C parser reads them: past the end is NUL. */
class Cursor {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  at(i: number): number {
    return i < this.bytes.length ? (this.bytes[i] as number) : 0;
  }
  digits(count: number): number | null {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const b = this.at(this.pos + i);
      if (!isDigit(b)) return null;
      value = value * 10 + (b - ZERO);
    }
    this.pos += count;
    return value;
  }
}

function findSeparator(b: Cursor, len: number): number {
  if (len === 7) return 7;
  if (b.at(4) === DASH) {
    if (b.at(5) !== WEEK) return 10;
    if (len > 8 && b.at(8) === DASH) {
      if (len === 9) return -1;
      return len > 10 && isDigit(b.at(10)) ? 8 : 10;
    }
    return 8;
  }
  if (b.at(4) !== WEEK) return 8;
  let idx = 7;
  while (idx < len && isDigit(b.at(idx))) idx++;
  if (idx < 9) return idx;
  return idx % 2 === 0 ? 7 : 8;
}

function isoWeekToDate(
  year: number,
  week: number,
  weekday: number,
): [number, number, number] | null {
  if (year < 1 || year > 9999) return null;
  if (week <= 0 || week >= 53) {
    const first = (ymdToOrdinal(year, 1, 1) + 6) % 7;
    if (!(week === 53 && (first === 3 || (first === 2 && isLeap(year))))) return null;
  }
  if (weekday <= 0 || weekday >= 8) return null;
  const jan1 = ymdToOrdinal(year, 1, 1);
  const jan1Weekday = (jan1 + 6) % 7;
  const week1Monday = jan1 - jan1Weekday + (jan1Weekday > 3 ? 7 : 0);
  return ordinalToYmd(week1Monday + (week - 1) * 7 + weekday - 1);
}

/** C `parse_isoformat_date`: null on a parse failure; field ranges are checked later. */
function parseDate(b: Cursor, len: number): [number, number, number] | null {
  b.pos = 0;
  const year = b.digits(4);
  if (year === null) return null;
  const sep = b.at(b.pos) === DASH;
  if (sep) b.pos++;
  if (b.at(b.pos) === WEEK) {
    b.pos++;
    const week = b.digits(2);
    if (week === null) return null;
    let weekday = 1;
    if (b.pos < len) {
      if (sep && b.at(b.pos++) !== DASH) return null;
      const d = b.digits(1);
      if (d === null) return null;
      weekday = d;
    }
    return isoWeekToDate(year, week, weekday);
  }
  const month = b.digits(2);
  if (month === null) return null;
  if (sep && b.at(b.pos++) !== DASH) return null;
  const day = b.digits(2);
  return day === null ? null : [year, month, day];
}

/** C `parse_hh_mm_ss_ff`: negative fails, 1 means characters remain before `end`. */
function parseHms(b: Cursor, end: number, out: number[]): number {
  let sep = true;
  for (let i = 0; i < 3; i++) {
    const v = b.digits(2);
    if (v === null) return -3;
    out[i] = v;
    const c = b.at(b.pos++);
    if (i === 0) sep = c === COLON;
    if (b.pos >= end) return c !== 0 ? 1 : 0;
    if (sep && c === COLON) continue;
    if (c === 0x2e || c === 0x2c) break;
    if (sep) return -4;
    b.pos--;
  }
  const remains = end - b.pos;
  const take = remains >= 6 ? 6 : remains;
  const fraction = b.digits(take);
  if (fraction === null) return -3;
  out[3] = fraction * 10 ** (6 - take);
  while (isDigit(b.at(b.pos))) b.pos++;
  return b.at(b.pos) !== 0 ? 1 : 0;
}

interface ParsedTime {
  hms: number[];
  /** Offset in microseconds; null for a naive time. */
  offset: bigint | null;
}

/** C `parse_isoformat_time`, from `start` to the end of the string. */
function parseTime(b: Cursor, start: number): ParsedTime | null {
  const len = b.bytes.length;
  let tz = start;
  do {
    const c = b.at(tz);
    if (c === ZULU || c === 0x2b || c === DASH) break;
  } while (++tz < len);
  const hms = [0, 0, 0, 0];
  b.pos = start;
  const rv = parseHms(b, tz, hms);
  if (rv < 0) return null;
  if (tz >= len) return rv === 1 ? null : { hms, offset: null };
  if (b.at(tz) === ZULU) return b.at(tz + 1) !== 0 ? null : { hms, offset: 0n };
  const off = [0, 0, 0, 0];
  b.pos = tz + 1;
  if (parseHms(b, len, off) !== 0) return null;
  const [h, m, s, us] = off as [number, number, number, number];
  const seconds = BigInt(h * 3600 + m * 60 + s);
  // A zero offset is UTC whatever its fraction says (C `tzinfo_from_isoformat_results`).
  if (seconds === 0n) return { hms, offset: 0n };
  const magnitude = seconds * 1_000_000n + BigInt(us);
  return { hms, offset: b.at(tz) === DASH ? -magnitude : magnitude };
}

function invalid(value: string): Error {
  return pyError("ValueError", `Invalid isoformat string: ${pyStrRepr(value)}`);
}

function checkDate(year: number, month: number, day: number): void {
  if (year < 1 || year > 9999) throw pyError("ValueError", `year ${year} is out of range`);
  if (month < 1 || month > 12) throw pyError("ValueError", "month must be in 1..12");
  if (day < 1 || day > daysInMonth(year, month)) {
    throw pyError("ValueError", "day is out of range for month");
  }
}

function timedeltaRepr(micros: bigint): string {
  let days = micros / MICROS_PER_DAY;
  let rest = micros % MICROS_PER_DAY;
  if (rest < 0n) {
    rest += MICROS_PER_DAY;
    days -= 1n;
  }
  const fields: string[] = [];
  if (days !== 0n) fields.push(`days=${days}`);
  if (rest / 1_000_000n !== 0n) fields.push(`seconds=${rest / 1_000_000n}`);
  if (rest % 1_000_000n !== 0n) fields.push(`microseconds=${rest % 1_000_000n}`);
  return `datetime.timedelta(${fields.join(", ") || "0"})`;
}

// Python can't UTF-8-encode a lone surrogate, so the C parser rejects any string holding one.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The (sanitized) UTF-8 bytes C parses, or null when Python cannot encode the string. */
function encodeForParse(value: string): Uint8Array | null {
  const points = Array.from(value);
  if (points.length < 7) return null;
  // C swaps a surrogate separator for "T" before encoding; any other lone surrogate fails.
  for (const pos of [7, 8, 10]) {
    const cp = points[pos]?.codePointAt(0);
    if (cp !== undefined && cp >= 0xd800 && cp <= 0xdfff) {
      points[pos] = "T";
      break;
    }
  }
  const clean = points.join("");
  return LONE_SURROGATE.test(clean) ? null : new TextEncoder().encode(clean);
}

/** `datetime.fromisoformat(value)`, as CPython's C implementation parses and validates it. */
export function parseIsoDatetime(value: unknown): PyDatetime {
  if (typeof value !== "string") throw pyError("TypeError", "fromisoformat: argument must be str");
  const bytes = encodeForParse(value);
  if (bytes === null) throw invalid(value);
  const b = new Cursor(bytes);
  const sepAt = findSeparator(b, bytes.length);
  const date = parseDate(b, sepAt);
  if (date === null || sepAt < 0) throw invalid(value);
  let time: ParsedTime = { hms: [0, 0, 0, 0], offset: null };
  if (bytes.length > sepAt) {
    // The separator is one character, however many UTF-8 bytes it takes.
    let start = sepAt + 1;
    while ((b.at(start) & 0xc0) === 0x80) start++;
    const parsed = parseTime(b, start);
    if (parsed === null) throw invalid(value);
    time = parsed;
  }
  const { offset } = time;
  if (offset !== null && (offset >= MICROS_PER_DAY || offset <= -MICROS_PER_DAY)) {
    throw pyError(
      "ValueError",
      "offset must be a timedelta strictly between -timedelta(hours=24) and " +
        `timedelta(hours=24), not ${timedeltaRepr(offset)}.`,
    );
  }
  const [year, month, day] = date;
  checkDate(year, month, day);
  const [hour, minute, second, micro] = time.hms as [number, number, number, number];
  if (hour > 23) throw pyError("ValueError", "hour must be in 0..23");
  if (minute > 59) throw pyError("ValueError", "minute must be in 0..59");
  if (second > 59) throw pyError("ValueError", "second must be in 0..59");
  const wall =
    BigInt(ymdToOrdinal(year, month, day) - EPOCH_ORDINAL) * MICROS_PER_DAY +
    BigInt(((hour * 60 + minute) * 60 + second) * 1_000_000 + micro);
  return offset === null ? { micros: wall, aware: false } : { micros: wall - offset, aware: true };
}

/** `date.fromisoformat(value)` as `[year, month, day]`, raising as CPython's C implementation does. */
export function parseIsoDate(value: string): [number, number, number] {
  const bytes = LONE_SURROGATE.test(value) ? null : new TextEncoder().encode(value);
  const len = bytes?.length ?? 0;
  const ok = bytes !== null && (len === 7 || len === 8 || len === 10);
  const date = ok ? parseDate(new Cursor(bytes), len) : null;
  if (date === null) throw invalid(value);
  checkDate(...date);
  return date;
}

const MIN_MICROS = BigInt(1 - EPOCH_ORDINAL) * MICROS_PER_DAY;
const MAX_MICROS = BigInt(ymdToOrdinal(9999, 12, 31) + 1 - EPOCH_ORDINAL) * MICROS_PER_DAY;

/**
 * mem0's `_normalize_iso_timestamp_to_utc`: an aware stamp becomes its `+00:00` isoformat; falsy,
 * naive and unparseable values come back unchanged. A non-string raises, as `fromisoformat` does.
 */
export function normalizeIsoTimestampToUtc(value: unknown): unknown {
  if (!pyTruthy(value)) return value;
  let parsed: PyDatetime;
  try {
    parsed = parseIsoDatetime(value);
  } catch (error) {
    if (error instanceof Error && error.name === "ValueError") return value;
    throw error;
  }
  if (!parsed.aware) return value;
  if (parsed.micros < MIN_MICROS || parsed.micros >= MAX_MICROS) {
    throw pyError("OverflowError", "date value out of range");
  }
  return isoUtc(partsFromMicros(parsed.micros));
}
