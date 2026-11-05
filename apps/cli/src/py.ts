// Python semantics the CLI output depends on that @eidolon/config doesn't cover: `textwrap.indent`,
// `statistics` and format-spec padding by code point.
import { cpLen, isPySpace, PyFloat, pyError, pyIter, pyTruthy, splitlines } from "@eidolon/config";

export type PyNumber = number | PyFloat;

export function numOf(x: PyNumber): number {
  return x instanceof PyFloat ? x.value : x;
}

/** `textwrap.indent(text, prefix)`: whitespace-only lines stay unprefixed. */
export function textwrapIndent(text: string, prefix: string): string {
  return splitlines(text, true)
    .map((line) => ([...line].every(isPySpace) ? line : prefix + line))
    .join("");
}

/** f-string `{s:<width}`, counted in code points. */
export function ljust(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cpLen(text)));
}

/** f-string `{s:>width}`, counted in code points. */
export function rjust(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - cpLen(text))) + text;
}

/** `value or []`, iterated. */
export function itemsOr(value: unknown): unknown[] {
  return pyTruthy(value) ? pyIter(value) : [];
}

function sortedNumbers(data: readonly number[]): number[] {
  return [...data].sort((a, b) => a - b);
}

/** `statistics.median`: the middle value, or the mean of the two middle values. */
export function median(data: readonly number[]): number {
  const sorted = sortedNumbers(data);
  const n = sorted.length;
  if (n === 0) throw pyError("StatisticsError", "no median for empty data");
  if (n % 2 === 1) return sorted[(n - 1) / 2] as number;
  return ((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2;
}

/** `statistics.quantiles(data, n=n)`, the default exclusive method. */
export function quantilesExclusive(data: readonly number[], n: number): number[] {
  if (n < 1) throw pyError("StatisticsError", "n must be at least 1");
  const sorted = sortedNumbers(data);
  const ld = sorted.length;
  if (ld < 2) {
    if (ld === 1) return Array.from({ length: n - 1 }, () => sorted[0] as number);
    throw pyError("StatisticsError", "must have at least one data point");
  }
  const m = ld + 1;
  const result: number[] = [];
  for (let i = 1; i < n; i++) {
    const j = Math.min(Math.max(Math.floor((i * m) / n), 1), ld - 1);
    const delta = i * m - j * n;
    result.push(((sorted[j - 1] as number) * (n - delta) + (sorted[j] as number) * delta) / n);
  }
  return result;
}

/** `statistics.mean`, summed in floating point where Python sums exactly; it prints as whole ms. */
export function mean(data: readonly number[]): number {
  if (data.length === 0) throw pyError("StatisticsError", "mean requires at least one data point");
  return data.reduce((sum, x) => sum + x, 0) / data.length;
}
