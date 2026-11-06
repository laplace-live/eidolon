// Where a user's settings, credentials and personas live. A persona is a built-in template under
// personas/<id>/ overlaid by the user's own personas/<id>/ folder: the user's copy of a file wins.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandUser, shippedPath } from "./paths.ts";
import { sortedPy } from "./py.ts";

/** The persona used when nothing names one. */
export const DEFAULT_PERSONA = "milky-green";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** `EIDOLON_HOME`, or `~/.laplace/eidolon`. Read from the process environment only. */
export function dataHome(): string {
  const configured = process.env.EIDOLON_HOME;
  return configured ? resolve(expandUser(configured)) : join(homedir(), ".laplace", "eidolon");
}

/** The personas that ship with the code. */
export function templatesDir(): string {
  return shippedPath("personas", "personas");
}

/** The user's folder for persona `id`, where edits and private data are written. */
export function personaHomeDir(id: string): string {
  return join(dataHome(), "personas", id);
}

export function personaTemplateDir(id: string): string {
  return join(templatesDir(), id);
}

/** Every persona id among the user's folders and the templates, sorted. */
export function personaIds(): string[] {
  const ids = new Set<string>();
  for (const root of [join(dataHome(), "personas"), templatesDir()]) {
    if (!isDirectory(root)) continue;
    for (const name of readdirSync(root)) {
      if (!name.startsWith(".") && isDirectory(join(root, name))) ids.add(name);
    }
  }
  return sortedPy(ids);
}

/**
 * Persona `id`'s file or folder at `rel`: the user's copy if it exists, else the template's, else
 * the user's path where it would be created. An absolute `rel` stands alone.
 */
export function resolvePersonaPath(id: string, rel: string): string {
  const path = expandUser(rel);
  if (isAbsolute(path)) return path;
  const own = join(personaHomeDir(id), path);
  if (exists(own)) return own;
  const template = join(personaTemplateDir(id), path);
  return exists(template) ? template : own;
}

/** The existing folders for `rel`, the user's first: a listing is their union. */
export function personaDirs(id: string, rel: string): string[] {
  return [join(personaHomeDir(id), rel), join(personaTemplateDir(id), rel)].filter(isDirectory);
}

/** What a persona's index is built from, kept apart from her folder so a deploy never copies it. */
export type SourceFolder = "facts" | "lists" | "vods" | "streams" | "eval";

export function sourcesDir(id: string): string {
  return join(dataHome(), "sources", id);
}

export function sourceFolder(id: string, folder: SourceFolder): string {
  return join(sourcesDir(id), folder);
}
