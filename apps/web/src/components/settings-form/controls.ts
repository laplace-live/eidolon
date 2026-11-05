// How the settings form shows a SETTINGS row and what it saves. A value is written so the bot reads
// it back from the file exactly as from the variable: @eidolon/config's asEnvValue joins a list
// with "," and resolves each path, and the readers split on "," and strip Python whitespace.
import type { SettingKind, SettingRow, SettingScope } from "@/lib/api";

export type Control =
  | { readonly type: "text" }
  | { readonly type: "integer"; readonly min?: number; readonly max?: number }
  | { readonly type: "number" }
  | { readonly type: "flag" }
  | { readonly type: "list" }
  | { readonly type: "path"; readonly inPersona: boolean }
  | { readonly type: "paths"; readonly inPersona: boolean }
  | { readonly type: "select"; readonly options: readonly string[] }
  | { readonly type: "timezone" }
  | { readonly type: "language" }
  | { readonly type: "voice" };

/** Fish Audio's TTS models; s1 retires on 2026-12-31. */
export const FISH_MODELS = ["drama-3", "s2.1-pro", "s2.1-pro-free", "s2-pro", "s1"] as const;

/** The browsers yt-dlp's --cookies-from-browser reads, and `none` for no cookies. */
export const COOKIE_BROWSERS = [
  "none",
  "chrome",
  "firefox",
  "safari",
  "edge",
  "brave",
  "chromium",
  "opera",
  "vivaldi",
  "whale",
] as const;

const BY_PATH: Readonly<Record<string, Control>> = {
  "voice.model": { type: "select", options: FISH_MODELS },
  "voice.voiceId": { type: "voice" },
  "selfie.quality": { type: "select", options: ["auto", "low", "medium", "high", "xhigh", "max"] },
  "sources.cookiesFromBrowser": { type: "select", options: COOKIE_BROWSERS },
  "identity.timezone": { type: "timezone" },
  "transcription.language": { type: "language" },
  "memory.qdrant.port": { type: "integer", min: 1, max: 65535 },
  "embeddings.dim": { type: "integer", min: 1 },
  "refine.concurrency": { type: "integer", min: 1 },
};

function byKind(kind: SettingKind, scope: SettingScope): Control {
  switch (kind) {
    case "string":
      return { type: "text" };
    case "int":
      return { type: "integer" };
    case "float":
      return { type: "number" };
    case "flag":
      return { type: "flag" };
    case "list":
      return { type: "list" };
    case "path":
      return { type: "path", inPersona: scope === "persona" };
    case "paths":
      return { type: "paths", inPersona: scope === "persona" };
  }
}

export function controlFor(row: Pick<SettingRow, "path" | "kind" | "scope">): Control {
  return BY_PATH[row.path] ?? byKind(row.kind, row.scope);
}

/** Python's `str.isspace()` set, which the readers strip from each item. */
export const SPACE_CLASS = String.raw`\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const EDGES = new RegExp(`^[${SPACE_CLASS}]+|[${SPACE_CLASS}]+$`, "g");

export function strip(text: string): string {
  return text.replace(EDGES, "");
}

function items(text: string, separator: string | RegExp): string[] {
  return text
    .split(separator)
    .map(strip)
    .filter((item) => item !== "");
}

const FLAG_ON = new Set(["true", "1", "yes", "on"]);
const FLAG_OFF = new Set(["false", "0", "no", "off"]);

/** What a control shows for a file's value; "" for a value no file sets. */
export function draftOf(value: unknown, control: Control): string {
  if (value === null || value === undefined) return "";
  switch (control.type) {
    case "flag": {
      const word = typeof value === "string" ? strip(value).toLowerCase() : String(value);
      if (FLAG_ON.has(word)) return "on";
      return FLAG_OFF.has(word) ? "off" : "";
    }
    case "list":
    case "paths": {
      const separator = control.type === "list" ? ", " : "\n";
      if (Array.isArray(value)) return value.map(String).join(separator);
      return items(String(value), ",").join(separator);
    }
    default:
      return Array.isArray(value) ? value.map(String).join(", ") : String(value);
  }
}

/** A draft as the value to save (null removes the key), or the locale key of what is wrong. */
export type Parsed =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const INT = /^[+-]?\d+(?:_\d+)*$/;
const FLOAT =
  /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const LANGUAGE = /^(?:[a-z]{2}|none)$/;
const VOICE_ID = /^[0-9a-f]{32}$/;
const URL_PREFIX = /^https?:\/\//;

const ok = (value: unknown): Parsed => ({ ok: true, value });
const fail = (error: string): Parsed => ({ ok: false, error });

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

let zones: readonly string[] | null = null;

/** Every IANA time zone the browser knows, for a field's suggestions. */
export function timeZones(): readonly string[] {
  zones ??= Intl.supportedValuesOf("timeZone");
  return zones;
}

/** Relative, and never climbing above the folder it resolves in. */
export function staysInside(path: string): boolean {
  if (/^[/\\~]/.test(path) || /^[A-Za-z]:/.test(path)) return false;
  let depth = 0;
  for (const segment of path.split(/[/\\]/)) {
    if (segment === "..") depth -= 1;
    else if (segment !== "" && segment !== ".") depth += 1;
    if (depth < 0) return false;
  }
  return true;
}

function parseNumber(text: string, control: Control & { type: "integer" | "number" }): Parsed {
  // NFKC turns full-width digits, which a Chinese input method types, into ASCII ones.
  const ascii = text.normalize("NFKC");
  if (control.type === "number") {
    const value = Number(ascii.replaceAll("_", ""));
    return FLOAT.test(ascii) && Number.isFinite(value)
      ? ok(value)
      : fail("settings.form.invalid.number");
  }
  const value = Number(ascii.replaceAll("_", ""));
  if (!INT.test(ascii) || !Number.isSafeInteger(value))
    return fail("settings.form.invalid.integer");
  if (control.min !== undefined && value < control.min) return fail("settings.form.invalid.min");
  if (control.max !== undefined && value > control.max) return fail("settings.form.invalid.max");
  return ok(value);
}

export function parseDraft(draft: string, control: Control): Parsed {
  switch (control.type) {
    case "flag":
      return ok(draft === "on" ? true : draft === "off" ? false : null);
    case "list": {
      const list = items(draft, ",");
      return ok(list.length > 0 ? list : null);
    }
    case "paths": {
      const paths = items(draft, /\r?\n/);
      for (const path of paths) {
        // The reader splits the joined value on ",", so a comma would cut a path in two.
        if (path.includes(",")) return fail("settings.form.invalid.comma");
        if (control.inPersona && !URL_PREFIX.test(path) && !staysInside(path)) {
          return fail("settings.form.invalid.relative");
        }
      }
      return ok(paths.length > 0 ? paths : null);
    }
    default:
      break;
  }
  const text = strip(draft);
  if (text === "") return ok(null);
  switch (control.type) {
    case "integer":
    case "number":
      return parseNumber(text, control);
    case "path":
      return control.inPersona && !staysInside(text)
        ? fail("settings.form.invalid.relative")
        : ok(text);
    case "timezone":
      return isTimeZone(text) ? ok(text) : fail("settings.form.invalid.timezone");
    case "language":
      return LANGUAGE.test(text) ? ok(text) : fail("settings.form.invalid.language");
    case "voice":
      return VOICE_ID.test(text) ? ok(text) : fail("settings.form.invalid.voice");
    default:
      return ok(text);
  }
}

/** A select's choices: its own, then the file's value when it is none of them, so it isn't lost. */
export function optionsOf(control: Control & { type: "select" }, current: string): string[] {
  const options = [...control.options];
  if (current !== "" && !options.includes(current)) options.push(current);
  return options;
}

/** Changing either needs every index re-ingested and a new memory collection. */
export const REINDEX_PATHS: readonly string[] = ["embeddings.model", "embeddings.dim"];

/** Rows the form never shows: the active persona switches through PUT personas/active instead. */
const HIDDEN = new Set(["persona"]);

export const GROUPS = [
  "you",
  "voice",
  "persona",
  "models",
  "memory",
  "knowledge",
  "videos",
  "selfie",
  "providers",
  "sources",
  "production",
  "other",
] as const;

export type Group = (typeof GROUPS)[number];

const GROUP_OF: Readonly<Record<string, Group>> = {
  local: "you",
  voice: "voice",
  identity: "persona",
  prompt: "persona",
  hearing: "models",
  mind: "models",
  memory: "memory",
  knowledge: "knowledge",
  transcription: "videos",
  selfie: "selfie",
  providers: "providers",
  embeddings: "providers",
  rerank: "providers",
  sources: "sources",
  access: "production",
  network: "production",
  audio: "production",
  mcp: "production",
};

export function groupOf(path: string, scope: SettingScope): Group {
  const head = path.split(".")[0] ?? "";
  if (head === "refine") return scope === "app" ? "providers" : "videos";
  return GROUP_OF[head] ?? "other";
}

/** Shown unfolded; every other row sits under Advanced. */
export const BASIC: ReadonlySet<string> = new Set([
  "local.viewerName",
  "memory.qdrant.host",
  "memory.qdrant.port",
  "embeddings.model",
  "embeddings.dim",
  "sources.cookiesFromBrowser",
  "identity.timezone",
  "voice.voiceId",
  "voice.model",
  "mind.model",
  "memory.searchLimit",
  "knowledge.rerank.enabled",
  "knowledge.gate.enabled",
  "knowledge.facts.files",
  "transcription.language",
  "refine.model",
  "selfie.model",
  "selfie.quality",
]);

/** The scope's rows a local install uses, in the order of `paths` when given. */
export function visibleRows(
  rows: readonly SettingRow[],
  scope: SettingScope,
  paths?: readonly string[],
): SettingRow[] {
  const shown = rows.filter(
    (row) => row.scope === scope && !row.productionOnly && !HIDDEN.has(row.path),
  );
  if (!paths) return shown;
  const byPath = new Map(shown.map((row) => [row.path, row]));
  return paths.flatMap((path) => byPath.get(path) ?? []);
}

export interface Section {
  readonly group: Group;
  readonly rows: readonly SettingRow[];
}

/** Rows by group in GROUPS order, keeping their own order within one. */
function bySection(rows: readonly SettingRow[]): Section[] {
  return GROUPS.map((group) => ({
    group,
    rows: rows.filter((row) => groupOf(row.path, row.scope) === group),
  })).filter((section) => section.rows.length > 0);
}

export function sections(rows: readonly SettingRow[]): {
  readonly basic: Section[];
  readonly advanced: Section[];
} {
  return {
    basic: bySection(rows.filter((row) => BASIC.has(row.path))),
    advanced: bySection(rows.filter((row) => !BASIC.has(row.path))),
  };
}

/**
 * What a save sends: each edited row's new value, unless it is unchanged, and the locale key of
 * each row whose draft doesn't parse.
 */
export function changes(
  rows: readonly SettingRow[],
  drafts: Readonly<Record<string, string>>,
): { readonly values: Record<string, unknown>; readonly errors: Record<string, string> } {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const row of rows) {
    const draft = drafts[row.path];
    if (draft === undefined || row.envOverride || row.readOnly) continue;
    const control = controlFor(row);
    if (draft === draftOf(row.value, control)) continue;
    const parsed = parseDraft(draft, control);
    if (parsed.ok) values[row.path] = parsed.value;
    else errors[row.path] = parsed.error;
  }
  return { values, errors };
}
