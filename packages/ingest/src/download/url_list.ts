// The URL lists laplace-download and laplace-pipeline take: one URL per line.
import { existsSync, readFileSync } from "node:fs";
import { pyError, pyStrip, splitlines } from "@eidolon/config";

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `read_text(encoding="utf-8")`: strict, and a BOM stays part of the first line. */
function readUtf8(path: string): string {
  return UTF8.decode(readFileSync(path));
}

/**
 * Every line, stripped, that is neither blank nor a `#` comment, in order and with repeats. Throws
 * FileNotFoundError "URL list not found: <path>" when `path` doesn't exist.
 */
export function readUrlList(path: string): string[] {
  if (!existsSync(path)) throw pyError("FileNotFoundError", `URL list not found: ${path}`);
  return splitlines(readUtf8(path))
    .map((line) => pyStrip(line))
    .filter((line) => line !== "" && !line.startsWith("#"));
}
