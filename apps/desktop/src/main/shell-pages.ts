// The shell's pages, filled in when main serves them: the loading and failure pages at
// eidolon-app://shell/, and the waiting page the app's own address answers with while there is no
// backend. Each template is Vite's build of src/shell, with its stylesheet inline.
import { createHash } from "node:crypto";

export type ShellPageName = "loading" | "failed" | "waiting";

/** The pages' own strings, in one language. */
export interface ShellPageStrings {
  /** The language they are in, for `<html lang>`: "en" or "zh-Hans". */
  readonly lang: string;
  /** The loading page's status: "Starting Eidolon…". */
  readonly starting: string;
  /** The waiting page's status: "Waiting for Eidolon's server…". */
  readonly waiting: string;
  readonly tryAgain: string;
  readonly showLogs: string;
  readonly quit: string;
  /** The failure page's heading over the stderr tail. */
  readonly details: string;
}

/** What the failure page says went wrong, in the strings' language. */
export interface ShellFailure {
  readonly title: string;
  /** Why, in a sentence or two; empty for none. */
  readonly message: string;
  /** What the backend wrote to stderr, as it wrote it; the page shows its last lines. */
  readonly stderr: string;
}

/** A page to serve: its HTML, and the CSP that runs its own style and script and nothing else. */
export interface RenderedPage {
  readonly html: string;
  readonly csp: string;
}

export const STDERR_LINES = 20;

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const STYLE = /<style>([\s\S]*?)<\/style>/g;
const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** The last `count` lines of `text`, without the blank ones it ends with. */
export function lastLines(text: string, count: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

/** Each `{{key}}` in one pass, so a value's own braces stay text. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`the shell page has no value for {{${key}}}`);
    return escapeHtml(values[key]);
  });
}

function hash(text: string): string {
  return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}

/**
 * The page's own `<style>`, by hash, and on the failure page its script from the shell host; no
 * 'unsafe-inline' and nothing from anywhere else.
 */
function policy(html: string, script: boolean): string {
  const styles = [...html.matchAll(STYLE)].map(([, css]) => hash(css));
  return [
    "default-src 'none'",
    styles.length > 0 ? `style-src ${styles.join(" ")}` : null,
    script ? "script-src 'self'" : null,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ]
    .filter((directive) => directive !== null)
    .join("; ");
}

function render(template: string, values: Readonly<Record<string, string>>, script: boolean) {
  const html = fill(template, values);
  return { html, csp: policy(html, script) };
}

export function renderLoadingPage(template: string, strings: ShellPageStrings): RenderedPage {
  return render(template, { ...strings }, false);
}

/** Served at the app's address, where a script from 'self' would come from the backend. */
export function renderWaitingPage(template: string, strings: ShellPageStrings): RenderedPage {
  return render(template, { ...strings }, false);
}

export function renderFailedPage(
  template: string,
  strings: ShellPageStrings,
  failure: ShellFailure,
): RenderedPage {
  const { title, message, stderr } = failure;
  return render(
    template,
    { ...strings, title, message, stderr: lastLines(stderr, STDERR_LINES) },
    true,
  );
}

/** What the shell host serves at a path: a page by its name, or an asset the pages' build links. */
export type ShellRoute =
  | { readonly page: Exclude<ShellPageName, "waiting"> }
  | { readonly asset: string; readonly type: string };

const ASSET = /^\/assets\/([\w-]+\.(js|css))$/;
const TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
};

/**
 * Null for anything else: the waiting page belongs to the app's address, and `/loading.html` would
 * be its template unfilled.
 */
export function shellRoute(pathname: string): ShellRoute | null {
  if (pathname === "/loading") return { page: "loading" };
  if (pathname === "/failed") return { page: "failed" };
  const asset = ASSET.exec(pathname);
  if (asset === null) return null;
  return { asset: asset[1], type: TYPES[asset[2]] };
}
