// Strings live in src/locales/<lang>/<feature>.json, each a flat map whose keys are reached as
// `<feature>.<key>`: settings.json's "embeddings.model" is t("settings.embeddings.model").
import { createElement, Fragment, type ReactNode, useMemo, useSyncExternalStore } from "react";

export const LANGS = ["en", "zh-CN"] as const;
export type Lang = (typeof LANGS)[number];

export type Catalog = Readonly<Record<string, string>>;
export type Catalogs = Readonly<Record<Lang, Catalog>>;
export type Vars = Readonly<Record<string, string | number>>;
export type Translate = (key: string, vars?: Vars) => string;

const STORAGE_KEY = "eidolon.lang";
const PLACEHOLDER = /\{(\w+)\}/g;

function isLang(value: unknown): value is Lang {
  return (LANGS as readonly unknown[]).includes(value);
}

/** A stored choice, else the first Chinese or English entry in the browser's preferences. */
export function detectLang(stored: string | null, languages: readonly string[]): Lang {
  if (isLang(stored)) return stored;
  for (const tag of languages) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "zh") return "zh-CN";
    if (primary === "en") return "en";
  }
  return "en";
}

/**
 * Merges locale files, keyed by a path ending in `<lang>/<feature>.json` as import.meta.glob gives
 * them, into one catalog per language.
 */
export function buildCatalogs(files: Readonly<Record<string, unknown>>): Catalogs {
  const catalogs: Record<Lang, Record<string, string>> = { en: {}, "zh-CN": {} };
  for (const [path, content] of Object.entries(files)) {
    const match = /([^/]+)\/([^/]+)\.json$/.exec(path);
    const lang = match?.[1];
    if (!match || !isLang(lang)) throw new Error(`${path}: not under a known language folder`);
    if (typeof content !== "object" || content === null || Array.isArray(content)) {
      throw new Error(`${path}: expected a JSON object`);
    }
    for (const [key, text] of Object.entries(content)) {
      if (typeof text !== "string") throw new Error(`${path}: "${key}" is not a string`);
      catalogs[lang][`${match[2]}.${key}`] = text;
    }
  }
  return catalogs;
}

/** The `{name}` placeholders in a string, sorted and without repeats. */
export function placeholders(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1]))].sort();
}

/** Fills `{name}` placeholders; one without a value stays as written. */
export function format(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * A string whose `{name}` placeholders are React nodes, such as a variable's name in <code>: pass it
 * `t(key)` with no vars, which leaves the placeholders as written.
 */
export function rich(text: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode {
  const parts = text.split(/\{(\w+)\}/g);
  return createElement(
    Fragment,
    null,
    ...parts.map((part, index) => (index % 2 === 0 ? part : (nodes[part] ?? `{${part}}`))),
  );
}

/** The string in `lang`, else in English, else the key itself so a missing one shows. */
export function translate(catalogs: Catalogs, lang: Lang, key: string, vars?: Vars): string {
  return format(catalogs[lang][key] ?? catalogs.en[key] ?? key, vars);
}

const listeners = new Set<() => void>();
let catalogs: Catalogs = { en: {}, "zh-CN": {} };
let current: Lang = "en";

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Loads the catalogs and picks the starting language. Call once at boot, before rendering. */
export function initI18n(loaded: Catalogs): void {
  catalogs = loaded;
  current = detectLang(stored(), navigator.languages);
  document.documentElement.lang = current;
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not persisted; it still applies to this tab.
  }
  current = lang;
  document.documentElement.lang = lang;
  for (const listener of listeners) listener();
}

/** For code outside components, such as a toast from an event handler. */
export const t: Translate = (key, vars) => translate(catalogs, current, key, vars);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, () => current);
}

/** `t` for the current language; a component that calls it re-renders when the language changes. */
export function useT(): Translate {
  const lang = useLang();
  return useMemo<Translate>(() => (key, vars) => translate(catalogs, lang, key, vars), [lang]);
}
