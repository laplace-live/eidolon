// Python text semantics @eidolon/config doesn't cover: exception reprs, `rstrip`.
import { isPySpace, pyStrRepr } from "@eidolon/config";

/** Python `repr(e)` for an exception. */
export function errorRepr(error: unknown): string {
  if (error instanceof Error) return `${error.name}(${pyStrRepr(error.message)})`;
  return String(error);
}

/** Python `str.rstrip()`. */
export function pyRstrip(text: string): string {
  const points = [...text];
  let end = points.length;
  while (end > 0 && isPySpace(points[end - 1] as string)) end--;
  return points.slice(0, end).join("");
}
