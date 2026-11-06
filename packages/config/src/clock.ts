// One wall clock for the prompt's 现在是 line, the recall "today" and the selfie lighting, so all
// three agree across DST and ICU edge cases.
import { envOptional } from "./env.ts";
import { logger } from "./logger.ts";

const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const formatters = new Map<string, Intl.DateTimeFormat>();
let warnedZone: string | null = null;

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether the clock can keep `timeZone`'s time, rather than fall back to UTC. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** `PERSONA_TIMEZONE` or Asia/Shanghai; an unknown zone warns once and falls back to UTC. */
export function personaTimeZone(): string {
  const zone = envOptional("PERSONA_TIMEZONE") ?? DEFAULT_TIME_ZONE;
  if (isValidTimeZone(zone)) return zone;
  if (warnedZone !== zone) {
    warnedZone = zone;
    logger.warning(
      `PERSONA_TIMEZONE invalid or tzdata missing ('No time zone found with key ${zone}'); ` +
        "falling back to UTC. On Windows or slim Docker images, install the `tzdata` package.",
    );
  }
  return "UTC";
}

export interface ZonedClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Python `date.weekday()`: Monday is 0, Sunday is 6. */
  weekday: number;
  /** `YYYY-MM-DD`. */
  isoDate: string;
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** The wall clock in `timeZone` at `now`. */
export function zonedClock(timeZone: string, now: Date = new Date()): ZonedClock {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(now)) parts[part.type] = part.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday as string] ?? 0,
    isoDate: `${String(year).padStart(4, "0")}-${parts.month}-${parts.day}`,
  };
}
