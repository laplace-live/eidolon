// Python text semantics @eidolon/config doesn't cover: type names, exception reprs, `rstrip`.
import { isPySpace, pyStrRepr } from "@eidolon/config";

/** `type(value).__name__` for a JSON-shaped value. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  switch (typeof value) {
    case "string":
      return "str";
    case "boolean":
      return "bool";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    case "bigint":
      return "int";
  }
  return Array.isArray(value) ? "list" : "dict";
}

/** An Error whose `name` is the Python exception class, so `errorRepr` prints like `{e!r}`. */
export function pyError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Python `repr(e)` for an exception. */
export function errorRepr(error: unknown): string {
  if (error instanceof Error) return `${error.name}(${pyStrRepr(error.message)})`;
  return String(error);
}

/** Python `str(e)` for what a provider or tool caught. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Python `str.rstrip()`. */
export function pyRstrip(text: string): string {
  const points = [...text];
  let end = points.length;
  while (end > 0 && isPySpace(points[end - 1] as string)) end--;
  return points.slice(0, end).join("");
}
