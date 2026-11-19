// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/core/tools/path-utils.ts@ac78a60 and packages/coding-agent/src/utils/paths.ts@ac78a60
//
// A path as a model writes it, made a path on disk: odd spaces, a leading @ and ~ dealt with, and
// relative to the task's folder. A read also tries the spellings macOS gives screenshots.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u{a0}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}]/gu;
const NARROW_NO_BREAK_SPACE = "\u{202f}";
const RIGHT_SINGLE_QUOTE = "\u{2019}";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `path` with Unicode spaces made plain, a leading @ dropped, a leading ~ expanded and a file: URL
 * made a path. `~draft.md` stays a file name.
 */
export function expandPath(path: string): string {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return join(homedir(), normalized.slice(2));
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

/** `path` expanded, and absolute: as it is, or against `cwd`. */
export function resolveToCwd(path: string, cwd: string): string {
  const expanded = expandPath(path);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** `resolveToCwd`'s path, else the first spelling of it macOS may have used that exists. */
export async function resolveReadPath(path: string, cwd: string): Promise<string> {
  const resolved = resolveToCwd(path, cwd);
  if (await pathExists(resolved)) return resolved;
  // macOS may store a name decomposed, and its screenshots put a narrow no-break space before AM
  // or PM, and U+2019 where people type an apostrophe (French "Capture d'écran").
  const decomposed = resolved.normalize("NFD");
  const curly = (name: string) => name.replace(/'/g, RIGHT_SINGLE_QUOTE);
  for (const variant of [
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    decomposed,
    curly(resolved),
    curly(decomposed),
  ]) {
    if (variant !== resolved && (await pathExists(variant))) return variant;
  }
  return resolved;
}
