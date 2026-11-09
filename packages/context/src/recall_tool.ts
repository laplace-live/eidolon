// The recall_streams wire contract. Arguments validate as a pydantic model would (lax mode, extra
// keys forbidden); the LLM reads `reason` when a call is rejected, so the error text keeps
// pydantic's layout, and dates coerce the way pydantic-core's speedate parser does.
import {
  cpLen,
  type PydanticLineError,
  pyRepr,
  pyStrip,
  validationErrorText,
} from "@eidolon/config";
import type { ToolSchema } from "@eidolon/core";
import type { IsoDate } from "@eidolon/retrieval";
import { isMessage } from "./messages.ts";

export const RECALL_TOOL_NAME = "recall_streams";

export const RECALL_PERIODS = [
  "latest",
  "previous",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "past_days",
  "date_range",
  "selected",
  "broadcasts",
  "all",
] as const;
export type RecallPeriod = (typeof RECALL_PERIODS)[number];

const RECALL_MODES = ["overview", "details"] as const;
export type RecallMode = (typeof RECALL_MODES)[number];

export const RECALL_STREAMS_SCHEMA: ToolSchema = {
  name: RECALL_TOOL_NAME,
  description:
    "查询自己的已归档直播。当前概览足够回答时直接回答；" +
    "需要其他场次、复杂时间指代或更具体的内容时调用。" +
    "结合对话解析用户指代，把问题改写成独立查询。" +
    "每个用户回合最多两次；查不到不能说没有直播，也不要编造。",
  properties: {
    query: { type: "string", description: "独立、具体的直播问题或话题" },
    mode: {
      type: "string",
      enum: [...RECALL_MODES],
      description: "整场/一段时间回顾用 overview，具体言论或事件用 details",
    },
    period: {
      type: "string",
      enum: [...RECALL_PERIODS],
      description:
        "latest 最近一场；previous 倒数第二场；week 为周一到周日；" +
        "selected 沿用刚才已查询的场次/时间段；all 跨全部归档找话题。" +
        "broadcasts 选择概览里已提供的 broadcast_ids，例如其中第二场。" +
        "昨天或明确日期用 date_range，不要猜测未经查询的场次 ID。",
    },
    start_date: { type: "string", description: "date_range 起始日 YYYY-MM-DD" },
    end_date: {
      type: "string",
      description: "date_range 结束日 YYYY-MM-DD，不包含该日；只查一天时省略",
    },
    days: {
      type: "integer",
      minimum: 1,
      maximum: 366,
      description: "past_days 天数，包含今天，默认 7",
    },
    broadcast_ids: {
      type: "array",
      items: { type: "string" },
      description: "仅填写概览已经给出的场次 ID，不要编造",
    },
  },
  required: ["query", "mode", "period"],
};

export const TOOL_BUDGET_SPENT = "本回合查询次数已用完，请根据已有记录回答。";
export const TOOL_FAILED = "直播查询未完成";

export type RecallToolResult =
  | { readonly content: string; readonly broadcast_ids: string[]; readonly chunk_ids: unknown[] }
  | { readonly error: string; readonly reason: string }
  | { readonly error: string };

export interface RecallRequest {
  readonly query: string;
  readonly mode: RecallMode;
  readonly period: RecallPeriod;
  readonly startDate: IsoDate | null;
  readonly endDate: IsoDate | null;
  readonly days: number;
  readonly broadcastIds: readonly string[];
}

/** pydantic's ValidationError; `message` is its `str()`. */
export class RecallRequestError extends Error {
  readonly errors: readonly PydanticLineError[];

  constructor(errors: readonly PydanticLineError[]) {
    super(validationErrorText("RecallRequest", errors));
    this.name = "ValidationError";
    this.errors = errors;
  }
}

class Invalid {
  readonly errors: readonly PydanticLineError[];

  constructor(errors: readonly PydanticLineError[]) {
    this.errors = errors;
  }
}

function fail(type: string, msg: string, input: unknown): never {
  throw new Invalid([{ loc: [], type, msg, input }]);
}

const FIELDS = new Set([
  "query",
  "mode",
  "period",
  "start_date",
  "end_date",
  "days",
  "broadcast_ids",
]);

/** Throws RecallRequestError, listing fields in model order and then each extra key. */
export function parseRecallRequest(args: unknown): RecallRequest {
  if (!isMessage(args)) {
    throw new RecallRequestError([
      {
        loc: [],
        type: "model_type",
        msg: "Input should be a valid dictionary or instance of RecallRequest",
        input: args,
      },
    ]);
  }
  const errors: PydanticLineError[] = [];
  const optional = <T>(name: string, validate: (input: unknown) => T): T | undefined => {
    const input = args[name];
    if (input === undefined) return undefined;
    try {
      return validate(input);
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      for (const e of error.errors) errors.push({ ...e, loc: [name, ...e.loc] });
      return undefined;
    }
  };
  const required = <T>(name: string, validate: (input: unknown) => T): T | undefined => {
    if (args[name] !== undefined) return optional(name, validate);
    errors.push({ loc: [name], type: "missing", msg: "Field required", input: args });
    return undefined;
  };
  const query = required("query", (input) => stringOf(input, 1, 2000));
  const mode = required("mode", (input) => literalOf(input, RECALL_MODES));
  const period = required("period", (input) => literalOf(input, RECALL_PERIODS));
  const startDate = optional("start_date", dateOf) ?? null;
  const endDate = optional("end_date", dateOf) ?? null;
  const days = optional("days", (input) => intOf(input, 1, 366)) ?? 7;
  const broadcastIds = optional("broadcast_ids", (input) => stringListOf(input, 20)) ?? [];
  for (const [key, input] of Object.entries(args)) {
    if (!FIELDS.has(key)) {
      errors.push({
        loc: [key],
        type: "extra_forbidden",
        msg: "Extra inputs are not permitted",
        input,
      });
    }
  }
  if (errors.length > 0 || query === undefined || mode === undefined || period === undefined) {
    throw new RecallRequestError(errors);
  }
  return { query, mode, period, startDate, endDate, days, broadcastIds };
}

function stringOf(input: unknown, min: number, max: number): string {
  if (typeof input !== "string") fail("string_type", "Input should be a valid string", input);
  const length = cpLen(input);
  if (length < min) {
    fail("string_too_short", `String should have at least ${min} character${plural(min)}`, input);
  }
  if (length > max) {
    fail("string_too_long", `String should have at most ${max} character${plural(max)}`, input);
  }
  return input;
}

function literalOf<T extends string>(input: unknown, values: readonly T[]): T {
  if ((values as readonly unknown[]).includes(input)) return input as T;
  const quoted = values.map((value) => pyRepr(value));
  const expected =
    quoted.length === 1
      ? quoted[0]
      : `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
  return fail("literal_error", `Input should be ${expected}`, input);
}

const INT_STRING = /^([+-]?\d+(?:_\d+)*)(?:\.0+)?$/;

function intOf(input: unknown, ge: number, le: number): number {
  let value: number;
  if (typeof input === "boolean") value = input ? 1 : 0;
  else if (typeof input === "number") {
    if (!Number.isFinite(input)) fail("finite_number", "Input should be a finite number", input);
    if (!Number.isInteger(input)) {
      fail(
        "int_from_float",
        "Input should be a valid integer, got a number with a fractional part",
        input,
      );
    }
    value = input;
  } else if (typeof input === "string") {
    const match = INT_STRING.exec(pyStrip(input));
    if (!match) {
      fail(
        "int_parsing",
        "Input should be a valid integer, unable to parse string as an integer",
        input,
      );
    }
    value = Number((match[1] as string).replaceAll("_", ""));
  } else {
    fail("int_type", "Input should be a valid integer", input);
  }
  if (value < ge) {
    fail("greater_than_equal", `Input should be greater than or equal to ${ge}`, input);
  }
  if (value > le) fail("less_than_equal", `Input should be less than or equal to ${le}`, input);
  return value;
}

// pydantic-core checks the length as each item is counted, so an over-long list reports only
// too_long, whatever its items hold.
function stringListOf(input: unknown, maxItems: number): string[] {
  if (!Array.isArray(input)) fail("list_type", "Input should be a valid list", input);
  if (input.length > maxItems) {
    fail(
      "too_long",
      `List should have at most ${maxItems} item${plural(maxItems)} after validation, not ${input.length}`,
      input,
    );
  }
  const errors: PydanticLineError[] = [];
  input.forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push({
        loc: [index],
        type: "string_type",
        msg: "Input should be a valid string",
        input: item,
      });
    }
  });
  if (errors.length > 0) throw new Invalid(errors);
  return [...input];
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

const encoder = new TextEncoder();

const DATE_PARSING = "Input should be a valid date or datetime, ";
const YEAR_ZERO = "Input should be a valid date in the format YYYY-MM-DD, year 0 is out of range";
const INEXACT = "Datetimes provided to dates should have zero time - e.g. be exact dates";

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };
type Ymd = readonly [year: number, month: number, day: number];

function dateOf(input: unknown): IsoDate | null {
  if (input === null) return null;
  if (typeof input === "number") {
    if (Number.isNaN(input)) {
      fail("date_from_datetime_parsing", `${DATE_PARSING}NaN values not permitted`, input);
    }
    const seconds = Math.floor(input);
    return dateFromTimestamp(seconds, Math.round((input - seconds) * 1_000_000), input);
  }
  if (typeof input !== "string") fail("date_type", "Input should be a valid date", input);
  const bytes = encoder.encode(input);
  const date = datePrefix(bytes);
  if (date.ok && bytes.length === 10) return isoOf(date.value, input);
  if (INTEGER.test(input)) return dateFromTimestamp(Number(input), 0, input);
  const datetime = dateTime(bytes);
  if (datetime.ok) {
    const [ymd, zeroTime] = datetime.value;
    if (!zeroTime) fail("date_from_datetime_inexact", INEXACT, input);
    return isoOf(ymd, input);
  }
  if (FLOAT.test(input)) {
    const float = Number(input);
    const seconds = Math.floor(float);
    return dateFromTimestamp(seconds, Math.round((float - seconds) * 1_000_000), input);
  }
  return fail("date_from_datetime_parsing", DATE_PARSING + datetime.error, input);
}

const INTEGER = /^[+-]?\d+$/;
const FLOAT = /^[+-]?(?:\d+\.\d*|\.\d+)$/;
// Timestamps above 2e10 count as milliseconds; seconds must land within years 0000-9999.
const MS_WATERSHED = 20_000_000_000;
const FIRST_SECOND = -62_167_219_200;
const LAST_SECOND = 253_402_300_799;

function dateFromTimestamp(timestamp: number, micros: number, input: unknown): IsoDate {
  const outOfRange = (bound: string): never =>
    fail(
      "date_from_datetime_parsing",
      `${DATE_PARSING}dates ${bound} are not supported as unix timestamps`,
      input,
    );
  if (timestamp === Number.NEGATIVE_INFINITY) outOfRange("before 0000");
  if (timestamp === Number.POSITIVE_INFINITY) outOfRange("after 9999");
  let seconds = timestamp;
  let micro = micros;
  if (Math.abs(seconds) > MS_WATERSHED) {
    seconds = Math.floor(timestamp / 1000);
    micro += (timestamp - seconds * 1000) * 1000;
  }
  seconds += Math.floor(micro / 1_000_000);
  micro %= 1_000_000;
  if (seconds > LAST_SECOND) outOfRange("after 9999");
  if (seconds < FIRST_SECOND) outOfRange("before 0000");
  if (seconds % 86_400 !== 0 || micro !== 0) fail("date_from_datetime_inexact", INEXACT, input);
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function isoOf([year, month, day]: Ymd, input: unknown): IsoDate {
  if (year === 0) fail("date_parsing", YEAR_ZERO, input);
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function digits(bytes: Uint8Array, start: number, count: number): number | null {
  let value = 0;
  for (let i = start; i < start + count; i++) {
    const byte = bytes[i];
    if (byte === undefined || byte < 0x30 || byte > 0x39) return null;
    value = value * 10 + (byte - 0x30);
  }
  return value;
}

const DASH = 0x2d;
const COLON = 0x3a;

function datePrefix(bytes: Uint8Array): Parsed<Ymd> {
  if (bytes.length < 10) return { ok: false, error: "input is too short" };
  const year = digits(bytes, 0, 4);
  if (year === null) return { ok: false, error: "invalid character in year" };
  if (bytes[4] !== DASH) return { ok: false, error: "invalid date separator, expected `-`" };
  const month = digits(bytes, 5, 2);
  if (month === null) return { ok: false, error: "invalid character in month" };
  if (bytes[7] !== DASH) return { ok: false, error: "invalid date separator, expected `-`" };
  const day = digits(bytes, 8, 2);
  if (day === null) return { ok: false, error: "invalid character in day" };
  if (month < 1 || month > 12) {
    return { ok: false, error: "month value is outside expected range of 1-12" };
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lastDay = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (day < 1 || day > lastDay) return { ok: false, error: "day value is outside expected range" };
  return { ok: true, value: [year, month, day] };
}

/** The date of a datetime string, and whether its time of day is exactly midnight. */
function dateTime(bytes: Uint8Array): Parsed<readonly [Ymd, boolean]> {
  const date = datePrefix(bytes);
  if (!date.ok) return date;
  if (![0x54, 0x74, 0x20, 0x5f].includes(bytes[10] as number)) {
    return { ok: false, error: "invalid datetime separator, expected `T`, `t`, `_` or space" };
  }
  const time = timeOfDay(bytes, 11);
  if (!time.ok) return time;
  return { ok: true, value: [date.value, time.value] };
}

function timeOfDay(bytes: Uint8Array, offset: number): Parsed<boolean> {
  const error = (message: string): Parsed<boolean> => ({ ok: false, error: message });
  if (bytes.length - offset < 5) return error("input is too short");
  const hour = digits(bytes, offset, 2);
  if (hour === null) return error("invalid character in hour");
  if (bytes[offset + 2] !== COLON) return error("invalid time separator, expected `:`");
  const minute = digits(bytes, offset + 3, 2);
  if (minute === null) return error("invalid character in minute");
  let length = 5;
  let second = 0;
  let fraction = false;
  if (bytes[offset + 5] === COLON) {
    const parsed = digits(bytes, offset + 6, 2);
    if (parsed === null) return error("invalid character in second");
    second = parsed;
    length = 8;
    const separator = bytes[offset + 8];
    if (separator === 0x2e || separator === 0x2c) {
      length = 9;
      let count = 0;
      for (;;) {
        const byte = bytes[offset + length + count];
        if (byte === undefined || byte < 0x30 || byte > 0x39) break;
        // Digits past the sixth are dropped, as microseconds are.
        if (count < 6 && byte !== 0x30) fraction = true;
        count++;
      }
      if (count === 0) return error("second fraction digits missing after `.`");
      length += count;
    }
  }
  if (hour > 23) return error("hour value is outside expected range of 0-23");
  if (minute > 59) return error("minute value is outside expected range of 0-59");
  if (second > 59) return error("second value is outside expected range of 0-59");
  const sign = bytes[offset + length];
  if (sign === 0x5a || sign === 0x7a) length += 1;
  else if (sign === 0x2b || sign === DASH) {
    const tzHour = digits(bytes, offset + length + 1, 2);
    if (tzHour === null) return error("invalid timezone hour");
    let at = offset + length + 3;
    if (bytes[at] === COLON) at++;
    const tzMinute = digits(bytes, at, 2);
    if (tzMinute === null) return error("invalid timezone minute");
    if (tzHour * 60 + tzMinute >= 24 * 60) {
      return error("timezone offset must be less than 24 hours");
    }
    length = at + 2 - offset;
  } else if (sign !== undefined) return error("invalid timezone sign");
  if (bytes.length > offset + length) {
    return error("unexpected extra characters at the end of the input");
  }
  return { ok: true, value: hour === 0 && minute === 0 && second === 0 && !fraction };
}
