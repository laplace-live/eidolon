// The UI's languages. Strings are English source text in Lingui macros; `<lang>.po` holds each
// language's catalog, which the Vite plugin compiles when it is imported.
import { i18n, type Messages } from "@lingui/core";
import { useLingui } from "@lingui/react";

export const LANGS = ["en", "zh-Hans"] as const;
export type Lang = (typeof LANGS)[number];

/** Each language's name in itself, as the language switch shows it. */
export const LANG_NAMES: Readonly<Record<Lang, string>> = { en: "English", "zh-Hans": "中文" };

const STORAGE_KEY = "eidolon.lang";

// Explicit map, not `import(./${lang}.po)`: a variable import of its own directory is invalid for
// vite:dynamic-import-vars. Still one chunk per catalog.
const catalogs = {
  en: () => import("./en.po"),
  "zh-Hans": () => import("./zh-Hans.po"),
} satisfies Record<Lang, unknown>;

function isLang(value: unknown): value is Lang {
  return (LANGS as readonly unknown[]).includes(value);
}

/** A stored choice, else the first Chinese or English entry in the browser's preferences. */
export function detectLang(stored: string | null, languages: readonly string[]): Lang {
  if (isLang(stored)) return stored;
  // A choice saved as zh-CN means the same language.
  if (stored === "zh-CN") return "zh-Hans";
  for (const tag of languages) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "zh") return "zh-Hans";
    if (primary === "en") return "en";
  }
  return "en";
}

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The language to start in: the viewer's saved choice, else the browser's. */
export function initialLang(): Lang {
  return detectLang(stored(), navigator.languages);
}

/**
 * Loads `lang`'s catalog, on demand, and makes it the active language: English when it can't load,
 * and with neither, English without a catalog, so the page renders rather than staying blank.
 */
export async function dynamicActivate(lang: Lang): Promise<void> {
  const [active, messages] = await loadCatalog(lang);
  i18n.load(active, messages);
  i18n.activate(active);
  document.documentElement.lang = active;
}

async function loadCatalog(lang: Lang): Promise<[Lang, Messages]> {
  for (const candidate of lang === "en" ? (["en"] as const) : ([lang, "en"] as const)) {
    try {
      return [candidate, (await catalogs[candidate]()).messages];
    } catch {
      // The next candidate, or none.
    }
  }
  return ["en", {}];
}

/** Switches the UI to `lang` and remembers the choice in this browser. */
export async function setLang(lang: Lang): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not remembered; it still applies to this tab.
  }
  await dynamicActivate(lang);
}

/** The active language; a component that calls it re-renders when it changes. */
export function useLang(): Lang {
  return useLingui().i18n.locale as Lang;
}
