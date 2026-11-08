// laplace-extract-users' library: viewer names mined from a danmakus.com export, ranked by how
// often their paid messages came in, since those are the names the streamer reads aloud and a
// glossary's `terms` should know.
import {
  isPlainObject,
  PyFloat,
  pyError,
  pyGet,
  pyParseFloat,
  pyParseInt,
  pyRepr,
  pyStr,
  pyStrip,
  pyTruthy,
  pyTypeName,
} from "@eidolon/config";

/** danmakus.com's message types. Its data shows type 1 is a gift and type 3 a super chat. */
export const TYPE_LABELS: ReadonlyMap<number, string> = new Map([
  [0, "free chat"],
  [1, "gift"],
  [2, "membership"],
  [3, "SC"],
  [4, "room entry"],
  [5, "title update"],
  [8, "stream start"],
  [9, "ban"],
]);

/** Gifts, memberships and super chats: the messages a streamer reads names from. */
export const DEFAULT_INCLUDE_TYPES: ReadonlySet<number> = new Set([1, 2, 3]);

/** `--types`: `all` for no filter, else a comma list of type numbers. Throws with argparse's text. */
export function parseTypes(arg: string): Set<number> | null {
  if (pyStrip(arg).toLowerCase() === "all") return null;
  const types = new Set<number>();
  for (const raw of arg.split(",")) {
    const piece = pyStrip(raw);
    if (!piece) continue;
    const value = pyParseInt(piece);
    if (value === null) throw new RangeError(`--types: '${piece}' is not an integer or 'all'`);
    types.add(value);
  }
  if (types.size === 0) throw new RangeError("--types must include at least one type");
  return types;
}

/** The export isn't shaped as danmakus.com writes one. */
export class DanmakuShapeError extends Error {
  override name = "DanmakuShapeError";
}

/** `value[key]` with Python's KeyError and TypeError texts. */
function subscript(value: unknown, key: string): unknown {
  if (isPlainObject(value)) {
    if (Object.hasOwn(value, key)) return value[key];
    throw new DanmakuShapeError(
      `unexpected JSON shape (expected .data.data.danmakus): ${pyRepr(key)}`,
    );
  }
  const reason = Array.isArray(value)
    ? "list indices must be integers or slices, not str"
    : typeof value === "string"
      ? "string indices must be integers, not 'str'"
      : `'${pyTypeName(value)}' object is not subscriptable`;
  throw new DanmakuShapeError(`unexpected JSON shape (expected .data.data.danmakus): ${reason}`);
}

/** The export's `.data.data.danmakus` list. */
export function danmakuItems(payload: unknown): unknown[] {
  const items = subscript(subscript(subscript(payload, "data"), "data"), "danmakus");
  if (!Array.isArray(items)) throw new DanmakuShapeError(".data.data.danmakus is not a list");
  return items;
}

/** A JSON number (a bool is an int to Python); null for anything else. */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (value instanceof PyFloat) return value.value;
  if (typeof value === "boolean") return Number(value);
  return null;
}

/** `isinstance(value, int)`. */
function asInt(value: unknown): number | null {
  if (typeof value === "boolean") return Number(value);
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Python's `int(value)`. */
function toInt(value: unknown): number {
  const n = numeric(value);
  if (n !== null) return Math.trunc(n);
  const parsed = typeof value === "string" ? pyParseInt(value) : null;
  if (parsed === null) {
    throw pyError("ValueError", `invalid literal for int() with base 10: ${pyRepr(value)}`);
  }
  return parsed;
}

/** Python's `float(value)`. */
function toFloat(value: unknown): number {
  const n = numeric(value);
  if (n !== null) return n;
  const parsed = typeof value === "string" ? pyParseFloat(value) : null;
  if (parsed === null) {
    throw pyError("ValueError", `could not convert string to float: ${pyRepr(value)}`);
  }
  return parsed;
}

/** Python's `sum()` of floats: Neumaier-compensated since 3.12. */
export function pySumFloats(values: Iterable<number>): number {
  let total = 0;
  let compensation = 0;
  for (const x of values) {
    const t = total + x;
    compensation += Math.abs(total) >= Math.abs(x) ? total - t + x : x - t + total;
    total = t;
  }
  return compensation && Number.isFinite(compensation) ? total + compensation : total;
}

export interface DanmakuReport {
  readonly totalEntries: number;
  /** Viewers with an id and a name, whatever their messages' types. */
  readonly uniqueUsers: number;
  readonly earliestMs: number | null;
  readonly latestMs: number | null;
  /** Entries without a uId or uName. */
  readonly skippedNoId: number;
  /** Per type, every entry and the entries the filter kept, in type order. */
  readonly typeCountsAll: readonly [number, number][];
  readonly typeCountsKept: readonly [number, number][];
  /** How many viewers had a message the filter kept: none means the filter matched nothing. */
  readonly counted: number;
  /** Every type's prices, so it is lifetime spend. */
  readonly totalSpend: number;
  readonly topSpenders: readonly { readonly name: string; readonly spend: number }[];
  /** The `top` names whose kept messages were most frequent; ties in first-seen order. */
  readonly names: readonly string[];
}

const byType = (counts: Map<number, number>): [number, number][] =>
  [...counts].sort((a, b) => a[0] - b[0]);

function bump(counts: Map<number, number>, key: number): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * Ranks the viewers in `items` by their messages of `types` (null for all), keeping each viewer's
 * latest name, since viewers rename themselves between archives.
 */
export function rankUsers(
  items: readonly unknown[],
  options: { readonly types: ReadonlySet<number> | null; readonly top: number },
): DanmakuReport {
  const counts = new Map<number, number>();
  const spend = new Map<number, number>();
  const lastName = new Map<number, [number, string]>();
  const typeCountsAll = new Map<number, number>();
  const typeCountsKept = new Map<number, number>();
  let earliest: number | null = null;
  let latest: number | null = null;
  let skippedNoId = 0;
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    const uidRaw = pyGet(item, "uId");
    const uname = pyGet(item, "uName");
    const msgType = pyGet(item, "type");
    const sendRaw = pyGet(item, "sendDate");
    const sendDate = pyTruthy(sendRaw) ? (numeric(sendRaw) ?? toInt(sendRaw)) : 0;
    const priceRaw = pyGet(item, "price");
    const price = pyTruthy(priceRaw) ? toFloat(priceRaw) : 0;
    const type = asInt(msgType);
    if (type !== null) bump(typeCountsAll, type);
    if (!pyTruthy(uidRaw) || !pyTruthy(uname)) {
      skippedNoId++;
      continue;
    }
    const uid = toInt(uidRaw);
    spend.set(uid, (spend.get(uid) ?? 0) + price);
    const prev = lastName.get(uid);
    if (prev === undefined || sendDate >= prev[0]) {
      lastName.set(uid, [Math.trunc(sendDate), pyStr(uname)]);
    }
    if (sendDate) {
      if (earliest === null || sendDate < earliest) earliest = Math.trunc(sendDate);
      if (latest === null || sendDate > latest) latest = Math.trunc(sendDate);
    }
    const kind = numeric(msgType);
    if (options.types !== null && (kind === null || !options.types.has(kind))) continue;
    bump(counts, uid);
    if (type !== null) bump(typeCountsKept, type);
  }
  const nameOf = (uid: number): string => lastName.get(uid)?.[1] ?? "?";
  const topSpenders = [...spend]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([uid, total]) => ({ name: nameOf(uid), spend: total }));
  const names =
    options.top > 0
      ? [...counts]
          .sort((a, b) => b[1] - a[1])
          .slice(0, options.top)
          .map(([uid]) => nameOf(uid))
      : [];
  return {
    totalEntries: items.length,
    uniqueUsers: lastName.size,
    earliestMs: earliest,
    latestMs: latest,
    skippedNoId,
    typeCountsAll: byType(typeCountsAll),
    typeCountsKept: byType(typeCountsKept),
    counted: counts.size,
    totalSpend: pySumFloats(spend.values()),
    topSpenders,
    names,
  };
}
