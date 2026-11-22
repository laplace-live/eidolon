// The desktop app's bridge: its preload puts `eidolonDesktop` on the app's own page, and a browser
// has none, so everything that differs in the desktop app asks `desktop()` first.
import { i18n } from "@lingui/core";
import type { Lang } from "@/locales/i18n";
import { onThemeChange, type Theme, themeSetting } from "./theme";

export interface EidolonDesktop {
  /** Node's name for the OS the app runs on: "darwin" or "win32". */
  readonly platform: string;
  /** The desktop app's own version, apart from the server's. */
  readonly version: string;
  /** The version of the server the app ships. */
  readonly serverVersion: string;
  /** The setting as chosen: a resolved theme would hold the window off the OS's under System. */
  readonly setTheme: (setting: Theme) => void;
  readonly setLanguage: (language: Lang) => void;
  /** Hands `callback` each command the app's menus send, such as `settings`. */
  readonly onCommand: (callback: (command: string) => void) => void;
}

declare global {
  var eidolonDesktop: EidolonDesktop | undefined;
}

/** The bridge, or null in a browser. */
export function desktop(): EidolonDesktop | null {
  return globalThis.eidolonDesktop ?? null;
}

/** What each command the desktop app's menus send does here; any other is ignored. */
const COMMANDS = {
  settings: (navigate) => navigate("/settings"),
} satisfies Record<string, (navigate: (to: string) => void) => void>;

export type DesktopCommand = keyof typeof COMMANDS;

export function runCommand(command: string, navigate: (to: string) => void): void {
  if (Object.hasOwn(COMMANDS, command)) COMMANDS[command as DesktopCommand](navigate);
}

/**
 * Tells the desktop app the theme setting and the language, now and on every change, and runs its
 * menus' commands through `navigate`. Nothing in a browser.
 */
export function connectDesktop(navigate: (to: string) => void): void {
  const app = desktop();
  if (app === null) return;
  let theme: Theme | null = null;
  const reportTheme = (next: Theme) => {
    if (next === theme) return;
    theme = next;
    app.setTheme(next);
  };
  reportTheme(themeSetting());
  onThemeChange(reportTheme);
  let language: string | null = null;
  // Lingui announces a catalog's load before it activates it, so the active locale decides.
  const reportLanguage = () => {
    const next = i18n.locale;
    if (!next || next === language) return;
    language = next;
    app.setLanguage(next as Lang);
  };
  reportLanguage();
  i18n.on("change", reportLanguage);
  app.onCommand((command) => runCommand(command, navigate));
}
