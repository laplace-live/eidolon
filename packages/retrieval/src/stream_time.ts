// Resolves common archive periods before the conversational model runs. The patterns are Python's,
// verbatim, through PyPattern.
import { cpSlice, pyStrip } from "@eidolon/config";
import {
  addDays,
  DateRangeError,
  diffDays,
  firstOfMonth,
  firstOfNextMonth,
  type IsoDate,
  isoDate,
  weekday,
  yearOf,
} from "./civil_date.ts";
import { isNdDigits, matchEnd, PyPattern, pyInt } from "./py.ts";

export interface StreamScope {
  readonly startDate: IsoDate | null;
  /** Exclusive. */
  readonly endDate: IsoDate | null;
  readonly latest: number | null;
  readonly streamIds: readonly string[];
  readonly label: string;
}

/** A scope with the Python dataclass defaults filled in. */
export function streamScope(init: Partial<StreamScope> = {}): StreamScope {
  return {
    startDate: init.startDate ?? null,
    endDate: init.endDate ?? null,
    latest: init.latest ?? null,
    streamIds: [...(init.streamIds ?? [])],
    label: init.label ?? "",
  };
}

const NUMBER = String.raw`(?:\d{1,3}|[一二三四五六七八九十两]{1,3})`;
const MONTH =
  `(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|` +
  `jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const DATE = new PyPattern(
  String.raw`(?<![\d/\-])(?:` +
    String.raw`(?P<iso_year>\d{4})[-/](?P<iso_month>\d{1,2})[-/](?P<iso_day>\d{1,2})(?!\d)` +
    String.raw`|(?:(?P<zh_year>\d{4}|\d{2})年\s*)?(?P<zh_month>\d{1,2})月\s*` +
    String.raw`(?P<zh_day>\d{1,2})(?:日|号)?(?!\d)` +
    String.raw`|\b(?P<en_month>${MONTH})\.?\s+(?P<en_day>\d{1,2})(?:st|nd|rd|th)?` +
    String.raw`(?:,?\s+(?P<en_year>\d{4}))?\b` +
    String.raw`|\b(?P<day_first>\d{1,2})(?:st|nd|rd|th)?\s+(?P<month_last>${MONTH})\.?` +
    String.raw`(?:,?\s+(?P<year_last>\d{4}))?\b)`,
  "i",
);
const RELATIVE = new PyPattern(
  String.raw`\b(?:this|last|previous)\s+(?:week|month)\b` +
    String.raw`|\b(?:the\s+)?(?:past|last)\s+${NUMBER}\s+days?\b` +
    String.raw`|\b(?:the\s+)?day before yesterday\b|\byesterday\b|\btoday\b` +
    `|(?:过去|最近|近)${NUMBER}天` +
    `|上上周|上周|这周|本周|上星期|这星期|本星期|上个月|这个月|本月|上月` +
    `|大前天|前天|昨天|今天`,
  "i",
);
const LATEST = new PyPattern(
  String.raw`\b(?:(?:second|2nd)[ -](?:last|latest|most recent)|last but one)\s+` +
    String.raw`(?:live\s*)?(?:stream|broadcast)\b` +
    String.raw`|\b(?:last|latest|most recent|previous)\s+(?:live\s*)?(?:stream|broadcast)\b` +
    `|(?:上上次|上上场|上次|上一场|上一次|最近一次|最后一次)(?:的)?(?:直播)?`,
  "i",
);
const FOLLOWUP = new PyPattern(
  String.raw`\b(?:that|same)\s+(?:week|month|day|stream|broadcast)\b` +
    String.raw`|\b(?:the\s+)?week before that\b|(?:上次)?那(?:一)?(?:周|星期|个月|天|场(?:直播)?|次(?:直播)?)` +
    `|同一(?:周|天|场直播)|再前一周`,
  "i",
);
const ORDINAL_FOLLOWUP = new PyPattern(
  String.raw`\b(?:the\s+)?(?P<en>first|second|third|\d+(?:st|nd|rd|th))\s+` +
    String.raw`(?:stream|broadcast)\b|第(?P<zh>[一二三四五六七八九十]|\d{1,2})(?:场|次)(?:直播)?`,
  "i",
);
const ELABORATION = new PyPattern(
  `(?:please )?(?:tell me more|go on|elaborate)(?: please)?|` +
    `(?:请)?(?:展开(?:说说|讲讲)|再(?:说说|讲讲)|详细(?:说说|讲讲))(?:吧|呗)?`,
  "i",
);
const RANGE_JOIN = new PyPattern(String.raw`\s*(?:到|至|—|–|~|～|-|to|through|until)\s*`, "i");
const YEAR_MONTH = new PyPattern(String.raw`(?<!\d)(\d{4}|\d{2})年\s*(\d{1,2})月(?!\s*\d)`);
const WEEKDAY = new PyPattern(
  String.raw`\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|` +
    String.raw`sat(?:urday)?|sun(?:day)?)\b|(?:周|星期)[一二三四五六日天末]`,
  "i",
);
const MONTHS = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (month, index) => [month, index + 1],
  ),
);

const YEAR_MONTH_QUALIFIER = new PyPattern(
  String.raw`\d+[年月/\-]|之前|以前|之后|以后|以来|左右|` +
    String.raw`\b(?:since|before|after|until)\b`,
  "i",
);
const LOOSE_DATE = new PyPattern(String.raw`\d{1,4}[/\-]\d{1,2}|\d+月\d|\d{2,4}年`);
const YEAR_WORD = new PyPattern(String.raw`去年|前年|今年|明年|\b(?:last|this|next) year\b`, "i");
const LEADING_QUALIFIER = new PyPattern(
  String.raw`\b(?:before|after|since|until|around|ending|starting)\s*$|` +
    String.raw`(?:早于|晚于|自从|大约)\s*$`,
  "i",
);
const TRAILING_QUALIFIER = new PyPattern(
  String.raw`\s*(?:之前|以前|之后|以后|左右|起|\bonward\b)`,
  "i",
);
const SHORT_END = new PyPattern(String.raw`\s*(?:到|至|—|–|~|～|-)\s*(\d{1,2})(?:日|号)(?!\d)`);
const RANGE_DASH = new PyPattern(String.raw`\s*(?:到|至|—|–|~|～|-)`);
const RANGE_WORD = new PyPattern(
  String.raw`\s*(?:到|至|—|–|~|～|-|\bto\b|\bthrough\b|\buntil\b)`,
  "i",
);
const BETWEEN = new PyPattern(String.raw`\bbetween\s*$`, "i");
const WEEK_WORD = new PyPattern(`week|周|星期`);
const MONTH_WORD = new PyPattern(`month|月`);
const DAY_WORD = new PyPattern(`day|天`);
const LAST_WORD = new PyPattern(`last|previous|上`);
const NUMBER_PATTERN = new PyPattern(NUMBER);
const RELATIVE_SUFFIX = new PyPattern(
  String.raw`[一二三四五六日天末]|\s+(?:of|before|after|until|through)\b`,
  "i",
);
const RELATIVE_DAY_SUFFIX = new PyPattern(`(?:的)?(?:第一天|最后一天)`);
const DAY_OF_PREFIX = new PyPattern(String.raw`\b(?:first|last) day of\s*$`, "i");
const RELATIVE_PREFIX = new PyPattern(
  String.raw`\b(?:before|after|since|until)\s*$|(?:截至|从)\s*$`,
  "i",
);
const SECOND_LATEST = new PyPattern(`second|2nd|but one|上上`);
const ORDINAL_SUFFIX = new PyPattern(`(?:st|nd|rd|th)$`);
const LOOSE_TIME = new PyPattern(
  String.raw`\d{1,4}[/\-]\d{1,2}|\d+[年月日号]|去年|前年|今年|明年|` +
    String.raw`\b(?:last|this|next|previous|past)\s+(?:\w+\s+)?(?:week|month|year|days?)\b|` +
    String.raw`\b(?:week|month|year)\s+(?:before|after)\b|` +
    String.raw`\b(?:in|during|from|to|since|until)\s+${MONTH}\b|\b${MONTH}\s+\d`,
  "i",
);
const ARCHIVE_WORDS = new PyPattern(
  String.raw`\b(?:streams?|streamed|streaming|broadcasts?|broadcasted|vods?)\b|直播|录播|` +
    `(?:上次|上周|这周|本周|昨天|前天|上个月|那周|那天).{0,12}(?:播了|播的|玩了|聊了)`,
  "i",
);
const RECAP_WORDS = new PyPattern(
  String.raw`\b(?:you (?:say|said|talk|talked|play|played)|recap|summari[sz]e)\b|` +
    `(?:你|您)?.{0,4}(?:说了|聊了|讲了|播了|玩了)|总结|回顾`,
  "i",
);
const POSSESSIVE = new PyPattern(String.raw`\s*'s\b`);
const PREPOSITIONS = new PyPattern(String.raw`\b(?:on|in|during|over|from|to|through)\b`);
const LONE_DASH = new PyPattern(String.raw`(?<=\s)(?:到|至|—|–|~|～|-)(?=\s)`);
const WHITESPACE_RUN = new PyPattern(String.raw`\s+`);
const ENGLISH_OVERVIEW = new PyPattern(
  `(?:please |can you |could you )?` +
    `(?:what (?:did you (?:stream|broadcast|do)|have you (?:streamed|broadcast)|` +
    `was (?:your |the )?(?:stream(?:'s)? |broadcast(?:'s)? )?(?:content|about)|` +
    `were (?:your |the )?(?:streams|broadcasts) about)|` +
    `(?:summari[sz]e|recap) (?:(?:your|the|that|those) )?(?:streams?|broadcasts?)?|` +
    `(?:give me )?(?:a )?(?:summary|recap|overview)(?: of)?` +
    `(?: (?:(?:your|the|that|those) )?(?:streams?|broadcasts?))?|what about)`,
);
const CHINESE_OVERVIEW = new PyPattern(
  String.raw`(?:请|能不能|可以)?(?:你|您)?\s*(?:的)?\s*(?:直播)?\s*` +
    `(?:(?:都|主要)?(?:播|播了|直播了|聊了|做了|讲了)(?:些)?(?:什么|啥)(?:内容)?|` +
    `(?:直播)?内容(?:是)?(?:什么|啥)|(?:有|有哪些)(?:什么)?直播|` +
    `(?:总结|回顾)(?:一下)?(?:你)?(?:的)?(?:直播)?|呢)`,
);

const CJK_DIGITS = new Map([
  ["一", 1],
  ["二", 2],
  ["三", 3],
  ["四", 4],
  ["五", 5],
  ["六", 6],
  ["七", 7],
  ["八", 8],
  ["九", 9],
  ["两", 2],
]);
const ORDINAL_WORDS = new Map([
  ["first", 1],
  ["second", 2],
  ["third", 3],
]);
const DAYS_BACK = new Map([
  ["today", 0],
  ["今天", 0],
  ["yesterday", 1],
  ["昨天", 1],
  ["前天", 2],
  ["大前天", 3],
  ["day before yesterday", 2],
  ["the day before yesterday", 2],
]);
const OVERVIEW_STRIP = " \t\n?!？！。.";

type DateParts = [number | null, number, number];

function numberValue(text: string): number {
  if (isNdDigits(text)) return pyInt(text);
  const ten = text.indexOf("十");
  if (ten !== -1) {
    const tens = text.slice(0, ten);
    const units = text.slice(ten + 1);
    return (CJK_DIGITS.get(tens) ?? 1) * 10 + (CJK_DIGITS.get(units) ?? 0);
  }
  return CJK_DIGITS.get(text) ?? 0;
}

/** null where Python raises KeyError: IGNORECASE lets "ſeptember" match a month it can't look up. */
function dateParts(match: RegExpExecArray): DateParts | null {
  const g = match.groups ?? {};
  if (g.iso_year) {
    return [pyInt(g.iso_year), pyInt(g.iso_month as string), pyInt(g.iso_day as string)];
  }
  if (g.zh_month) {
    const year = g.zh_year ? pyInt(g.zh_year) : null;
    return [
      year !== null && year < 100 ? 2000 + year : year,
      pyInt(g.zh_month),
      pyInt(g.zh_day as string),
    ];
  }
  const year = g.en_year || g.year_last;
  const month = MONTHS.get(cpSlice((g.en_month || g.month_last) as string, 0, 3).toLowerCase());
  if (month === undefined) return null;
  return [year ? pyInt(year) : null, month, pyInt((g.en_day || g.day_first) as string)];
}

function inferredDate(year: number | null, month: number, day: number, today: IsoDate): IsoDate {
  if (year !== null) return isoDate(year, month, day);
  const inferred = isoDate(yearOf(today), month, day);
  return inferred > today ? isoDate(yearOf(today) - 1, month, day) : inferred;
}

function range(start: IsoDate, end: IsoDate): StreamScope {
  return streamScope({ startDate: start, endDate: end, label: `${start} 至 ${addDays(end, -1)}` });
}

function datesOrNull(compute: () => StreamScope | null): StreamScope | null {
  try {
    return compute();
  } catch (error) {
    if (error instanceof DateRangeError) return null;
    throw error;
  }
}

/** `[explicit, scope]`: whether the query names a calendar date, and its range when unambiguous. */
function explicitScope(query: string, today: IsoDate): [boolean, StreamScope | null] {
  const matches = DATE.finditer(query);
  const months = YEAR_MONTH.finditer(query);
  if (matches.length === 0 && months.length === 1) {
    const only = months[0] as RegExpExecArray;
    const year = pyInt(only[1] as string);
    const month = pyInt(only[2] as string);
    let start: IsoDate;
    let end: IsoDate;
    try {
      start = isoDate(year < 100 ? year + 2000 : year, month, 1);
      end = firstOfNextMonth(start);
    } catch (error) {
      if (error instanceof DateRangeError) return [true, null];
      throw error;
    }
    if (YEAR_MONTH_QUALIFIER.search(YEAR_MONTH.sub("", query))) return [true, null];
    return [true, range(start, end)];
  }
  if (LOOSE_DATE.search(DATE.sub("", query))) return [true, null];
  const first = matches[0];
  const last = matches[matches.length - 1];
  if (first === undefined || last === undefined) return [false, null];
  if (YEAR_WORD.search(query)) return [true, null];
  if (LEADING_QUALIFIER.search(query.slice(0, first.index))) return [true, null];
  if (TRAILING_QUALIFIER.match(query.slice(matchEnd(last)))) return [true, null];
  const parts: DateParts[] = [];
  for (const match of matches) {
    const part = dateParts(match);
    if (part === null) return [true, null];
    parts.push(part);
  }
  if (parts.length === 1) {
    const trailing = query.slice(matchEnd(first));
    const shortEnd = SHORT_END.match(trailing);
    if (shortEnd) {
      const [year, month] = parts[0] as DateParts;
      parts.push([year, month, pyInt(shortEnd[1] as string)]);
      if (RANGE_DASH.match(trailing.slice(matchEnd(shortEnd)))) return [true, null];
    } else if (RANGE_WORD.match(trailing)) {
      return [true, null];
    }
  } else {
    if (parts.length !== 2) return [true, null];
    const join = query.slice(matchEnd(first), (matches[1] as RegExpExecArray).index);
    const between = BETWEEN.search(query.slice(0, first.index));
    if (!RANGE_JOIN.fullmatch(join) && !(between && pyStrip(join).toLowerCase() === "and")) {
      return [true, null];
    }
  }
  return [
    true,
    datesOrNull(() => {
      if (parts.length === 1) {
        const start = inferredDate(...(parts[0] as DateParts), today);
        return range(start, addDays(start, 1));
      }
      let [startYear, startMonth, startDay] = parts[0] as DateParts;
      let [endYear, endMonth, endDay] = parts[1] as DateParts;
      const crossesYear = startMonth > endMonth ? 1 : 0;
      if (startYear !== null && endYear === null) endYear = startYear + crossesYear;
      else if (endYear !== null && startYear === null) startYear = endYear - crossesYear;
      else if (startYear === null && endYear === null) {
        endYear = yearOf(inferredDate(null, endMonth, endDay, today));
        startYear = endYear - crossesYear;
      }
      // Python's `or`: a year of 0 falls back to today's year too.
      const start = isoDate(startYear || yearOf(today), startMonth, startDay);
      const end = isoDate(endYear || yearOf(today), endMonth, endDay);
      if (start > end || diffDays(start, end) > 366) return null;
      return range(start, addDays(end, 1));
    }),
  ];
}

function relativeScope(text: string, today: IsoDate): StreamScope | null {
  const normalized = text.toLowerCase();
  if (WEEK_WORD.search(normalized)) {
    const weeksBack = text === "上上周" ? 2 : LAST_WORD.search(normalized) ? 1 : 0;
    const start = addDays(today, -(weekday(today) + 7 * weeksBack));
    return range(start, addDays(start, 7));
  }
  if (MONTH_WORD.search(normalized)) {
    const start = firstOfMonth(today);
    if (LAST_WORD.search(normalized)) return range(firstOfMonth(addDays(start, -1)), start);
    return range(start, firstOfNextMonth(start));
  }
  const number = NUMBER_PATTERN.search(normalized);
  if (number) {
    const days = numberValue(number[0]);
    if (days >= 1 && days <= 366) return range(addDays(today, -(days - 1)), addDays(today, 1));
    return null;
  }
  const daysBack = DAYS_BACK.get(normalized);
  if (daysBack === undefined) return null;
  const day = addDays(today, -daysBack);
  return range(day, addDays(day, 1));
}

/** A period, with exclusive end dates and a one-based latest-broadcast ordinal. */
export function resolveStreamScope(
  query: string,
  options: { today: IsoDate; previous?: StreamScope | null },
): StreamScope | null {
  const { today } = options;
  const previous = options.previous ?? null;
  if (isStreamElaboration(query)) return previous;
  const [explicit, scope] = explicitScope(query, today);
  const relative = RELATIVE.finditer(query);
  const followup = FOLLOWUP.finditer(query);
  const latest = LATEST.finditer(query).filter(
    (match) => !followup.some((f) => f.index <= match.index && matchEnd(match) <= matchEnd(f)),
  );
  const ordinal = ORDINAL_FOLLOWUP.finditer(query);
  if (WEEKDAY.search(query) && (explicit || relative.length > 0)) return null;
  const references = relative.length + latest.length + followup.length + ordinal.length;
  if (explicit) return references === 0 ? scope : null;
  if (references !== 1) return null;

  const rel = relative[0];
  if (rel !== undefined) {
    const before = query.slice(0, rel.index);
    const after = query.slice(matchEnd(rel));
    if (rel.index > 0 && "上大".includes(query[rel.index - 1] as string)) return null;
    if (RELATIVE_SUFFIX.match(after) || RELATIVE_DAY_SUFFIX.match(after)) return null;
    if (DAY_OF_PREFIX.search(before) || RELATIVE_PREFIX.search(before)) return null;
    return relativeScope(rel[0], today);
  }
  const newest = latest[0];
  if (newest !== undefined) {
    const n = SECOND_LATEST.search(newest[0].toLowerCase()) ? 2 : 1;
    return streamScope({ latest: n, label: n === 1 ? "最近一次直播" : "上上次直播" });
  }
  if (previous === null) return null;
  const nth = ordinal[0];
  if (nth !== undefined) {
    const groups = nth.groups ?? {};
    const value = ((groups.en || groups.zh) as string).toLowerCase();
    const n = ORDINAL_WORDS.get(value) ?? numberValue(ORDINAL_SUFFIX.sub("", value));
    if (!(n >= 1 && n <= previous.streamIds.length)) return null;
    return streamScope({
      streamIds: [previous.streamIds[n - 1] as string],
      label: `上次查询结果中的第${n}场直播`,
    });
  }
  const text = (followup[0] as RegExpExecArray)[0].toLowerCase();
  const { startDate, endDate } = previous;
  if (WEEK_WORD.search(text)) {
    if (startDate === null || endDate === null) return null;
    const weekStart = addDays(startDate, -weekday(startDate));
    if (endDate > addDays(weekStart, 7)) return null;
  }
  if (text.includes("before") || text === "再前一周") {
    if (startDate === null) return null;
    const end = addDays(startDate, -weekday(startDate));
    return range(addDays(end, -7), end);
  }
  if (WEEK_WORD.search(text)) {
    if (startDate === null) return null;
    const start = addDays(startDate, -weekday(startDate));
    return range(start, addDays(start, 7));
  }
  if (MONTH_WORD.search(text)) {
    if (startDate === null || endDate === null) return null;
    if (addDays(endDate, -1).slice(0, 7) !== startDate.slice(0, 7)) return null;
    return relativeScope("this month", startDate);
  }
  if (DAY_WORD.search(text)) {
    if (startDate === null || endDate !== addDays(startDate, 1)) return null;
  } else if (previous.latest === null && previous.streamIds.length !== 1) {
    return null;
  }
  return previous;
}

export function isStreamElaboration(query: string): boolean {
  return ELABORATION.fullmatch(pyStrip(query, OVERVIEW_STRIP)) !== null;
}

export function isStreamFollowup(query: string): boolean {
  return (
    FOLLOWUP.search(query) !== null ||
    ORDINAL_FOLLOWUP.search(query) !== null ||
    isStreamElaboration(query)
  );
}

export function hasStreamTimeReference(query: string): boolean {
  const patterns = [DATE, YEAR_MONTH, RELATIVE, LATEST, FOLLOWUP, ORDINAL_FOLLOWUP, WEEKDAY];
  if (patterns.some((pattern) => pattern.search(query) !== null)) return true;
  return LOOSE_TIME.search(query) !== null;
}

export function isStreamQuery(query: string): boolean {
  if (ARCHIVE_WORDS.search(query)) return true;
  const temporal = RELATIVE.search(query) ?? DATE.search(query) ?? FOLLOWUP.search(query);
  return temporal !== null && RECAP_WORDS.search(query) !== null;
}

export function isStreamOverview(query: string): boolean {
  let text = pyStrip(query.toLowerCase(), OVERVIEW_STRIP);
  for (const pattern of [DATE, YEAR_MONTH, RELATIVE, LATEST, FOLLOWUP])
    text = pattern.sub(" ", text);
  text = POSSESSIVE.sub("", text);
  text = PREPOSITIONS.sub("", text);
  text = pyStrip(LONE_DASH.sub("", text));
  text = WHITESPACE_RUN.sub(" ", text);
  return (
    ENGLISH_OVERVIEW.fullmatch(text) !== null ||
    CHINESE_OVERVIEW.fullmatch(text.replaceAll(" ", "")) !== null
  );
}
