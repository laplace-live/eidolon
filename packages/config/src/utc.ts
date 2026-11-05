// `datetime.now(timezone.utc).isoformat()` at microsecond resolution: records stamped in one batch
// get distinct, increasing stamps, and Python omits the fraction when it is zero.
import { ordinalToYmd } from "./calendar.ts";

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

/**
 * `datetime.now(timezone.utc).isoformat()` at this instant; the fraction is omitted when zero.
 * A bigint reaches instants past 2^53 microseconds (year 2255).
 */
export function pyIsoformatUtc(epochMicros: number | bigint): string {
  const p = partsFromMicros(BigInt(epochMicros));
  const time = `${pad(p.hour, 2)}:${pad(p.minute, 2)}:${pad(p.second, 2)}`;
  const fraction = p.micro === 0 ? "" : `.${pad(p.micro, 6)}`;
  return `${isoDate(p)}T${time}${fraction}+00:00`;
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
