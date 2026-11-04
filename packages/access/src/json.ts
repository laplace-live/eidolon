export type JsonObject = Record<string, unknown>;

/** Python `isinstance(value, dict)` for a JSON.parse result. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
