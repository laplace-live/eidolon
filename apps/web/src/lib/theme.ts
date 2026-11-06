// Light, dark or the system's choice, kept in localStorage and applied as the `dark` class on
// <html>, which index.css's `dark:` variant keys on.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

export interface ThemeState {
  readonly theme: Theme;
  readonly resolvedTheme: "light" | "dark";
}

const STORAGE_KEY = "eidolon.theme";
const DARK = "(prefers-color-scheme: dark)";

const listeners = new Set<() => void>();
let state: ThemeState = { theme: "system", resolvedTheme: "light" };

function stored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Storage can be off (private windows, blocked site data); the system's choice still applies.
  }
  return "system";
}

function apply(theme: Theme): void {
  const resolvedTheme = theme === "system" ? (matchMedia(DARK).matches ? "dark" : "light") : theme;
  const root = document.documentElement;
  root.classList.toggle("dark", resolvedTheme === "dark");
  root.style.colorScheme = resolvedTheme;
  state = { theme, resolvedTheme };
  for (const listener of listeners) listener();
}

/** Applies the stored theme and follows the system's while it is the choice. Call once at boot. */
export function initTheme(): void {
  apply(stored());
  matchMedia(DARK).addEventListener("change", () => {
    if (state.theme === "system") apply("system");
  });
}

export function setTheme(theme: Theme): void {
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not persisted; it still applies to this tab.
  }
  apply(theme);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): ThemeState & { setTheme: typeof setTheme } {
  return { ...useSyncExternalStore(subscribe, () => state), setTheme };
}
