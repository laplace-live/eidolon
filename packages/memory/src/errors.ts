// mem0's failures reach logs and admin outcomes as `{type(e).__name__}: {e}`, so errors raised in
// its place carry the Python exception name.
export function pyError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Python `str(e)` for a caught error. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PY_TYPE_NAMES: Record<string, string> = {
  string: "str",
  boolean: "bool",
  bigint: "int",
  undefined: "NoneType",
};

/** Python `type(value).__name__` for a JSON-shaped value. */
export function pyTypeName(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "object") return "dict";
  return PY_TYPE_NAMES[typeof value] ?? typeof value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** `value.get(key, fallback)`, raising Python's AttributeError when `value` is not a dict. */
export function pyGet(value: unknown, key: string, fallback: unknown = null): unknown {
  if (!isPlainObject(value)) {
    throw pyError("AttributeError", `'${pyTypeName(value)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** `for item in value` over a JSON value: lists yield items, strings code points, dicts keys. */
export function pyIter(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return Array.from(value);
  if (isPlainObject(value)) return Object.keys(value);
  throw pyError("TypeError", `'${pyTypeName(value)}' object is not iterable`);
}
