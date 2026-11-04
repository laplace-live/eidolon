// The Python server's validation errors and tool-result text come from pydantic, so its exact
// output is reproduced here for the JSON values a request or an envelope can carry.
import { pyRepr } from "@eidolon/config";

export interface LineError {
  readonly loc: string;
  readonly type: string;
  readonly message: string;
  readonly input: unknown;
}

function utf8Length(ch: string): number {
  const code = ch.codePointAt(0) as number;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return code < 0x10000 ? 3 : 4;
}

/**
 * pydantic-core's `input_value`: a repr over 50 UTF-8 bytes keeps its first 25 and last 24 bytes,
 * cut back to whole characters, around "...".
 */
function displayInput(value: unknown): string {
  const repr = pyRepr(value);
  const chars = [...repr];
  if (chars.reduce((n, ch) => n + utf8Length(ch), 0) <= 50) return repr;
  let head = "";
  for (let i = 0, bytes = 0; i < chars.length; i++) {
    bytes += utf8Length(chars[i] as string);
    if (bytes > 25) break;
    head += chars[i];
  }
  let tail = "";
  for (let i = chars.length - 1, bytes = 0; i >= 0; i--) {
    bytes += utf8Length(chars[i] as string);
    if (bytes > 24) break;
    tail = chars[i] + tail;
  }
  return `${head}...${tail}`;
}

/** Python `type(value).__name__` for a JSON value, deciding int vs float as pyRepr does. */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  switch (typeof value) {
    case "boolean":
      return "bool";
    case "number":
      return Number.isSafeInteger(value) ? "int" : "float";
    case "string":
      return "str";
  }
  return Array.isArray(value) ? "list" : "dict";
}

/** `str(ValidationError)` for a model named `title`. The URL names Python's pydantic version. */
export function validationErrorText(title: string, errors: readonly LineError[]): string {
  const count = `${errors.length} validation error${errors.length === 1 ? "" : "s"}`;
  const lines = errors.map(
    (e) =>
      `${e.loc}\n  ${e.message} [type=${e.type}, input_value=${displayInput(e.input)}, ` +
      `input_type=${pyTypeName(e.input)}]\n` +
      `    For further information visit https://errors.pydantic.dev/2.13/v/${e.type}`,
  );
  return [`${count} for ${title}`, ...lines].join("\n");
}

/**
 * pydantic-core's float text. It differs from JS number text: fixed notation only for decimal
 * exponents -5..15, always with a fraction (`1.0`), otherwise `1e-6`/`1e+16` style.
 */
export function pydanticFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (Object.is(value, -0)) return "-0.0";
  const exponential = value.toExponential();
  const exponent = Number(exponential.slice(exponential.indexOf("e") + 1));
  if (exponent < -5 || exponent > 15) return exponential;
  const fixed = String(value);
  return fixed.includes(".") ? fixed : `${fixed}.0`;
}

function encode(value: unknown, indent: string, key: string | null): string {
  if (typeof value === "number") return key === "score" ? pydanticFloat(value) : String(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => inner + encode(item, inner, null));
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  const items = entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${encode(v, inner, k)}`);
  return `{\n${items.join(",\n")}\n${indent}}`;
}

/**
 * `pydantic_core.to_json(envelope, indent=2)`, the text Python's SDK puts in a tool result. Every
 * number but a `score` is an int; scores are Python floats.
 */
export function envelopeText(envelope: unknown): string {
  return encode(envelope, "", null);
}
