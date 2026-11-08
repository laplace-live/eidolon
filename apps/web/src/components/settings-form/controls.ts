// How the settings form shows a SETTINGS row and what it saves. A value is written so the bot reads
// it back from the file exactly as from the variable: @eidolon/config's asEnvValue joins a list
// with "," and resolves each path, and the readers split on "," and strip Python whitespace.
import type { SettingKind, SettingRow, SettingScope } from "@/lib/api";
import {
  defaultModel,
  PROVIDERS,
  providerOfAccount,
  ROLES,
  type Role,
  roleById,
  roleOfModelEnv,
  roleOfProviderEnv,
} from "@/lib/providers";

export type Control =
  /** `placeholder`: what applies while it is empty, where that is a value, such as an API base. */
  | { readonly type: "text"; readonly placeholder?: string }
  | { readonly type: "integer"; readonly min?: number; readonly max?: number }
  | { readonly type: "number" }
  | { readonly type: "flag" }
  | { readonly type: "list" }
  | { readonly type: "path"; readonly inPersona: boolean }
  | { readonly type: "paths"; readonly inPersona: boolean }
  | { readonly type: "select"; readonly options: readonly string[] }
  | { readonly type: "timezone" }
  | { readonly type: "language" }
  /** Which provider fills a role: the catalog's that offer what it needs. */
  | { readonly type: "provider"; readonly role: Role }
  /** A role's model, suggested from its provider's. */
  | { readonly type: "model"; readonly role: Role }
  /** A voice: a provider's fixed set, or its id. */
  | { readonly type: "voice"; readonly role: Role };

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
  "voice.voiceId": { type: "voice", role: roleById("voice") },
  "realtime.voice": { type: "voice", role: roleById("realtime") },
  "hearing.language": { type: "language" },
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

export function controlFor(row: Pick<SettingRow, "path" | "env" | "kind" | "scope">): Control {
  const own = BY_PATH[row.path];
  if (own !== undefined) return own;
  const base = PROVIDERS.find((provider) => provider.baseUrlEnv === row.env)?.baseUrl;
  if (base) return { type: "text", placeholder: base };
  const provider = roleOfProviderEnv(row.env);
  if (provider !== undefined) return { type: "provider", role: provider };
  const model = roleOfModelEnv(row.env);
  if (model !== undefined) return { type: "model", role: model };
  return byKind(row.kind, row.scope);
}

/** The settings path holding a role's provider. */
function providerPath(role: Role): string {
  return `${role.path}.provider`;
}

/** The accounts as the pages know them: an id, and the provider it stands for. */
export type AccountList = readonly { readonly id: string; readonly provider: string }[];

/**
 * The account that fills `role` as the drafts stand: the draft, else her file's, else the
 * environment's, else the one it follows, else its provider's default; null when nothing turns it on.
 */
export function effectiveProvider(
  role: Role,
  rows: readonly Pick<SettingRow, "path" | "value" | "envValue" | "envOverride">[],
  drafts: Readonly<Record<string, string>>,
): string | null {
  const chosen = chosenValue(providerPath(role), rows, drafts);
  if (chosen !== null) return chosen.toLowerCase();
  if (role.follows !== undefined) return effectiveProvider(roleById(role.follows), rows, drafts);
  return role.defaultProvider;
}

/**
 * The value at `path` as the drafts stand: the draft, else her file's, else the environment's; an
 * app row's environment value wins over its file's, as the bot reads it.
 */
function chosenValue(
  path: string,
  rows: readonly Pick<SettingRow, "path" | "value" | "envValue" | "envOverride">[],
  drafts: Readonly<Record<string, string>>,
): string | null {
  const row = rows.find((candidate) => candidate.path === path);
  const draft = drafts[path];
  if (draft === undefined && row?.envOverride && row.envValue) return strip(row.envValue);
  const own =
    draft !== undefined ? strip(draft) : typeof row?.value === "string" ? strip(row.value) : "";
  if (own !== "") return own;
  return row?.envValue ? strip(row.envValue) : null;
}

/** The provider of the account that fills `role` as the drafts stand: models and voices are its. */
export function effectiveProviderType(
  role: Role,
  rows: readonly Pick<SettingRow, "path" | "value" | "envValue" | "envOverride">[],
  drafts: Readonly<Record<string, string>>,
  accounts: AccountList | undefined,
): string | null {
  return providerOfAccount(effectiveProvider(role, rows, drafts), accounts);
}

/**
 * The model `role` gets while she names none, as the drafts stand: the followed role's while both
 * use one provider, as the bot resolves it, else the provider's default; null when it needs one.
 */
export function fallbackModel(
  role: Role,
  rows: readonly Pick<SettingRow, "path" | "value" | "envValue" | "envOverride">[],
  drafts: Readonly<Record<string, string>>,
  accounts: AccountList | undefined,
): string | null {
  const provider = effectiveProviderType(role, rows, drafts, accounts);
  if (provider === null) return null;
  if (role.follows !== undefined) {
    const followed = roleById(role.follows);
    if (effectiveProviderType(followed, rows, drafts, accounts) === provider) {
      return (
        chosenValue(`${followed.path}.model`, rows, drafts) ??
        fallbackModel(followed, rows, drafts, accounts)
      );
    }
  }
  return defaultModel(role, provider);
}

/** The paths whose values belong to `role`'s provider: they go when it changes. */
function dependentsOf(role: Role): string[] {
  const dependents = [`${role.path}.model`];
  if (role.id === "voice") dependents.push("voice.voiceId");
  if (role.id === "realtime") dependents.push("realtime.voice");
  return dependents;
}

/**
 * What a save of `saving` leaves behind: the model and voice of every role whose provider the
 * drafts change, a role that follows another one's included, unless the save sets them itself.
 */
export function orphanedByProvider(
  rows: readonly SettingRow[],
  drafts: Readonly<Record<string, string>>,
  saving: Readonly<Record<string, unknown>>,
  accounts: AccountList | undefined,
): string[] {
  const cleared: string[] = [];
  for (const role of ROLES) {
    // Another account of the same provider takes the same models and voices.
    const before = effectiveProviderType(role, rows, {}, accounts);
    if (before === effectiveProviderType(role, rows, drafts, accounts)) continue;
    for (const path of dependentsOf(role)) {
      const dependent = rows.find((candidate) => candidate.path === path);
      if (dependent?.value != null && !(path in saving)) cleared.push(path);
    }
  }
  return cleared;
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

/** The browser's time zone, which a new persona starts with. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
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

/**
 * Changing either needs every index re-ingested and a new memory collection, as does another
 * embedding provider; another account of the same one doesn't.
 */
export const REINDEX_PATHS: readonly string[] = ["embeddings.model", "embeddings.dim"];

/** Rows the form never shows: the active persona switches through PUT personas/active instead. */
const HIDDEN = new Set([
  "persona",
  // Edited as an account's API base. A role's own still applies while it uses OpenRouter's account.
  "providers.openrouter.apiBase",
  "providers.openai.baseUrl",
  "embeddings.baseUrl",
  "rerank.baseUrl",
  "refine.baseUrl",
]);

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
  "usage",
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
  realtime: "models",
  memory: "memory",
  knowledge: "knowledge",
  transcription: "videos",
  selfie: "selfie",
  providers: "providers",
  embeddings: "providers",
  rerank: "providers",
  sources: "sources",
  usage: "usage",
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

/** The scope's rows a local install uses. */
export function visibleRows(rows: readonly SettingRow[], scope: SettingScope): SettingRow[] {
  return rows.filter((row) => row.scope === scope && !row.productionOnly && !HIDDEN.has(row.path));
}

interface Section {
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

/** A SettingsCard line: one row's path, or the paths of rows shown side by side. */
export type CardPath = string | readonly string[];

export interface CardSection {
  /** The legend over it: null when the card holds one group, or names its rows. */
  readonly group: Group | null;
  /** Each line is one row, or a few side by side. */
  readonly lines: readonly (readonly SettingRow[])[];
}

/**
 * A SettingsCard's rows: those `paths` names, in its order and lines, else every row of the scope
 * the local app shows, by group. Rows in `exclude` are left out either way.
 */
export function cardSections(
  rows: readonly SettingRow[],
  scope: SettingScope,
  paths?: readonly CardPath[],
  exclude: readonly string[] = [],
): CardSection[] {
  const skipped = new Set(exclude);
  const shown = visibleRows(rows, scope).filter((row) => !skipped.has(row.path));
  if (paths) {
    const byPath = new Map(shown.map((row) => [row.path, row]));
    const lines = paths
      .map((line) => (typeof line === "string" ? [line] : line).flatMap((p) => byPath.get(p) ?? []))
      .filter((line) => line.length > 0);
    return lines.length > 0 ? [{ group: null, lines }] : [];
  }
  const groups = bySection(shown);
  return groups.map(({ group, rows: inGroup }) => ({
    group: groups.length > 1 ? group : null,
    lines: inGroup.map((row) => [row]),
  }));
}

/**
 * Where the value a row's field shows comes from, as its draft stands:
 * - `locked`: an app row the environment sets, which wins over the file;
 * - `readOnly`: shown, never written through the API;
 * - `inherited`: a persona row she leaves unset, so the environment's value is hers;
 * - `overrides`: her own value, which wins over the environment's;
 * - `own`: the environment doesn't set it.
 */
export type Origin = "locked" | "readOnly" | "inherited" | "overrides" | "own";

export function originOf(
  row: Pick<SettingRow, "scope" | "envValue" | "envOverride" | "readOnly">,
  draft: string,
): Origin {
  if (row.envOverride) return "locked";
  if (row.readOnly) return "readOnly";
  if (row.scope !== "persona" || row.envValue === null) return "own";
  return strip(draft) === "" ? "inherited" : "overrides";
}

/** The environment's value as `control` shows it, or null when the environment sets none. */
export function envDraft(row: Pick<SettingRow, "envValue">, control: Control): string | null {
  return row.envValue === null ? null : draftOf(row.envValue, control);
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
