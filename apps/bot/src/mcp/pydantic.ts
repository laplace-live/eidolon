// Tool-result text in pydantic's exact JSON form, for the JSON values an envelope can carry.

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
 * `pydantic_core.to_json(envelope, indent=2)`, the text the MCP Python SDK puts in a tool result.
 * Every number but a `score` is an int; scores are Python floats.
 */
export function envelopeText(envelope: unknown): string {
  return encode(envelope, "", null);
}
