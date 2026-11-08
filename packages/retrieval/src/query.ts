import { cpLen, pyStrip } from "@eidolon/config";
import { PyPattern, pyInt } from "./py.ts";

// Each pattern is paired into 4-digit and 2-digit year variants because
// conversational Chinese abbreviates the year ("26年3月24") and routinely
// drops the day marker (日/号). The lookahead `(?=\s*[日号]|\D|$)` accepts a
// marker, a non-digit boundary, or end-of-string, so "5月8" reads as a date
// but "5月8000元" doesn't. `(?<!\d)` blocks matches inside longer numbers —
// "20260524年" must not yield "2026年" out of the middle.
const DATE_FULL = new PyPattern(
  String.raw`(?<!\d)(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})(?=\s*[日号]|\D|$)`,
);
const DATE_FULL_SHORT = new PyPattern(
  String.raw`(?<!\d)(\d{2})年\s*(\d{1,2})月\s*(\d{1,2})(?=\s*[日号]|\D|$)`,
);
const DATE_YM = new PyPattern(String.raw`(?<!\d)(\d{4})年\s*(\d{1,2})月(?=\D|$)`);
const DATE_YM_SHORT = new PyPattern(String.raw`(?<!\d)(\d{2})年\s*(\d{1,2})月(?=\D|$)`);
const DATE_MD = new PyPattern(String.raw`(?<!\d)(\d{1,2})月\s*(\d{1,2})(?=\s*[日号]|\D|$)`);

function normalizeYear(text: string): number {
  const year = pyInt(text);
  return year < 100 ? 2000 + year : year;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/**
 * A LanceDB `WHERE` clause for a date the query names, else null. A full date matches exactly, a
 * year+month becomes a half-open range, and a bare `MM月DD` matches that day in any year. Year-only
 * ("2024年发生什么") and month-only ("3月") are deliberately not filtered — too coarse to help,
 * and vector + FTS handle them better.
 */
export function extractDateFilter(query: string, options: { column?: string } = {}): string | null {
  const column = options.column ?? "date";
  if (!query) return null;
  for (const pattern of [DATE_FULL, DATE_FULL_SHORT]) {
    const m = pattern.search(query);
    if (!m) continue;
    const year = normalizeYear(m[1] as string);
    const month = pyInt(m[2] as string);
    const day = pyInt(m[3] as string);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) continue;
    return `${column} = '${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}'`;
  }
  for (const pattern of [DATE_YM, DATE_YM_SHORT]) {
    const m = pattern.search(query);
    if (!m) continue;
    const year = normalizeYear(m[1] as string);
    const month = pyInt(m[2] as string);
    if (!(month >= 1 && month <= 12)) continue;
    const [endYear, endMonth] = month === 12 ? [year + 1, 1] : [year, month + 1];
    return (
      `${column} >= '${pad(year, 4)}-${pad(month, 2)}-01' AND ` +
      `${column} < '${pad(endYear, 4)}-${pad(endMonth, 2)}-01'`
    );
  }
  const m = DATE_MD.search(query);
  if (!m) return null;
  const month = pyInt(m[1] as string);
  const day = pyInt(m[2] as string);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  return `${column} LIKE '%-${pad(month, 2)}-${pad(day, 2)}'`;
}

// Below this many chars we pull in prior turns: voice users say "嗯", "那呢",
// "再说说", and embedding those alone is hopeless.
export const SHORT_QUERY_CHARS = 8;

export interface MessageLike {
  readonly role?: unknown;
  readonly content?: unknown;
}

/**
 * The search query from recent user turns. A latest message of `shortThreshold` code points or
 * more is used alone; anything shorter gets up to `maxUserTurns` earlier user messages prepended,
 * oldest first. Assistant turns stay out even on short queries: their content drags retrieval
 * toward whatever the model rambled about. Skips non-object messages.
 */
export function buildQueryText(
  messages: readonly unknown[] | null | undefined,
  options: { maxUserTurns?: number; shortThreshold?: number } = {},
): string | null {
  const maxUserTurns = options.maxUserTurns ?? 3;
  const shortThreshold = options.shortThreshold ?? SHORT_QUERY_CHARS;
  if (!messages || messages.length === 0) return null;
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const { role, content } = message as MessageLike;
    if (role !== "user" || typeof content !== "string") continue;
    const text = pyStrip(content);
    if (text) texts.push(text);
    if (texts.length >= maxUserTurns) break;
  }
  const latest = texts[0];
  if (latest === undefined) return null;
  if (cpLen(latest) >= shortThreshold || texts.length === 1) return latest;
  return texts.reverse().join(" ");
}
