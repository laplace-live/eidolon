// The setup wizard's steps, and what it decides from the API's answers.
import {
  type AccountList,
  draftOf,
  effectiveProvider,
  effectiveProviderType,
  isTimeZone,
} from "@/components/settings-form/controls";
import type { AccountView, CreatePersonaRequest, SettingRow, Status } from "@/lib/api";
import { providerOfAccount, roleById } from "@/lib/providers";
import { requiredKeyMissing } from "./first-run";

export const STEPS = ["keys", "persona", "voice", "memory", "done"] as const;
export type Step = (typeof STEPS)[number];

export function isStep(value: unknown): value is Step {
  return (STEPS as readonly unknown[]).includes(value);
}

/**
 * Where the wizard opens: the keys while one the app waits for is missing, else the step a link
 * asked for.
 */
export function firstStep(status: Pick<Status, "keys">, requested: string | null): Step {
  if (requiredKeyMissing(status)) return "keys";
  return isStep(requested) ? requested : "keys";
}

export function nextStep(step: Step): Step {
  return STEPS[Math.min(STEPS.indexOf(step) + 1, STEPS.length - 1)] ?? step;
}

export function previousStep(step: Step): Step | null {
  return STEPS[STEPS.indexOf(step) - 1] ?? null;
}

/** The persona the repository ships as a demo. */
export const DEMO_PERSONA = "milky-green";

export const COOKIE_SETTING = "sources.cookiesFromBrowser";

/** Nothing in settings.yaml, the environment or any key store yet: this setup is the first. */
export function isNewInstall(
  rows: readonly SettingRow[],
  accounts: readonly Pick<AccountView, "key" | "saved">[],
): boolean {
  return (
    rows.every((row) => row.scope !== "app" || (row.source === "default" && !row.envOverride)) &&
    accounts.every((account) => !account.saved && account.key.source === null)
  );
}

/**
 * The cookie source a new install writes: none, so yt-dlp opens no browser's cookie store (and
 * its Keychain prompt) until the user asks. An existing value, or the environment's, stays.
 */
export function cookieDefault(
  rows: readonly SettingRow[],
  newInstall: boolean,
): Readonly<Record<string, string>> | null {
  const row = rows.find((candidate) => candidate.path === COOKIE_SETTING);
  if (!newInstall || !row || row.source !== "default" || row.envOverride) return null;
  return { [COOKIE_SETTING]: "none" };
}

/** A text row's own value, as her file sets it; null when it sets none. */
export function ownValue(row: Pick<SettingRow, "value"> | undefined): string | null {
  return typeof row?.value === "string" && row.value !== "" ? row.value : null;
}

/**
 * The environment's value a persona inherits for a persona row: the environment sets it and her
 * file doesn't, which would override it for her alone. Null otherwise.
 */
export function inheritedValue(
  row: Pick<SettingRow, "value" | "envValue"> | undefined,
): string | null {
  if (row === undefined || row.envValue === null) return null;
  return row.value === null || row.value === "" ? row.envValue : null;
}

/**
 * Whether a flag row is on: the environment's value when it overrides an app row, else her file's
 * value, else the environment's, else `fallback`, as the bot reads it.
 */
export function flagOn(
  row:
    | (Pick<SettingRow, "value" | "envValue"> & Partial<Pick<SettingRow, "envOverride">>)
    | undefined,
  fallback: boolean,
): boolean {
  const control = { type: "flag" } as const;
  if (row?.envOverride) {
    const env = draftOf(row.envValue, control);
    return env === "" ? fallback : env === "on";
  }
  const own = draftOf(row?.value ?? null, control);
  const set = own === "" ? draftOf(row?.envValue ?? null, control) : own;
  return set === "" ? fallback : set === "on";
}

/**
 * The provider a persona speaks through, whose voices the voice step offers: Fish Audio while her
 * settings name no account Eidolon knows, as the server checks a new persona's voice; null while
 * the account they name waits on `accounts`.
 */
export function voiceProvider(
  rows: readonly SettingRow[],
  accounts: AccountList | undefined,
): string | null {
  return (
    effectiveProviderType(roleById("voice"), rows, {}, accounts) ??
    (accounts === undefined ? null : "fish")
  );
}

/**
 * The Fish account a persona speaks through, whose own voices the picker lists beside the library;
 * null while she speaks through another provider, or an account Eidolon doesn't know.
 */
export function fishVoiceAccount(
  rows: readonly SettingRow[],
  accounts: AccountList | undefined,
): string | null {
  const account = effectiveProvider(roleById("voice"), rows, {});
  return providerOfAccount(account, accounts) === "fish" ? account : null;
}

/** A voice picked from one provider's voices. */
export interface VoicePick {
  readonly provider: string;
  readonly voice: string;
}

/** `pick`'s voice while she still speaks through the provider it came from. */
export function pickedVoice(pick: VoicePick | null, provider: string | null): string | null {
  return pick !== null && pick.provider === provider ? pick.voice : null;
}

/** Ids become folder names, lock keys and --persona, so they stay lowercase ASCII. */
export const PERSONA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The admin API's literal path words, which the server refuses as ids: they would read as routes. */
export const RESERVED_IDS: ReadonlySet<string> = new Set([
  "accounts",
  "active",
  "api",
  "approve",
  "assistant",
  "avatar",
  "batches",
  "chats",
  "check",
  "commands",
  "continue",
  "credentials",
  "events",
  "facts",
  "file",
  "files",
  "glossary",
  "identity",
  "index",
  "jobs",
  "live",
  "local",
  "log",
  "mcp",
  "memories",
  "messages",
  "models",
  "notification-avatar",
  "participants",
  "personas",
  "prompt",
  "read",
  "references",
  "restart",
  "resume",
  "search",
  "servers",
  "session",
  "settings",
  "skills",
  "status",
  "stop",
  "tasks",
  "usage",
  "voice",
  "voice-styles",
  "voices",
]);

const unusable = (id: string, taken: readonly string[]) =>
  taken.includes(id) || RESERVED_IDS.has(id);

/** A free id made from the name's ASCII letters and digits; "" when it has none. */
export function suggestPersonaId(name: string, taken: readonly string[]): string {
  const base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  if (base === "" || !unusable(base, taken)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 64 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!unusable(id, taken)) return id;
  }
}

export interface PersonaDraft {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly fans: string;
  readonly summary: string;
  readonly timezone: string;
}

export const EMPTY_PERSONA: PersonaDraft = {
  id: "",
  name: "",
  shortName: "",
  fans: "",
  summary: "",
  timezone: "",
};

/** What the bot calls a viewer when persona.yaml leaves `fans` out (IDENTITY_DEFAULTS). */
export const DEFAULT_FANS = "观众";

/** The locale key of what is wrong with each field; empty when the draft can be created. */
export function personaErrors(
  draft: PersonaDraft,
  taken: readonly string[],
): Partial<Record<keyof PersonaDraft, string>> {
  const errors: Partial<Record<keyof PersonaDraft, string>> = {};
  const id = draft.id.trim();
  if (!PERSONA_ID.test(id)) errors.id = "errors.invalid-persona-id";
  else if (RESERVED_IDS.has(id)) errors.id = "setup.persona.id.reserved";
  else if (taken.includes(id)) errors.id = "errors.persona-exists";
  if (draft.name.trim() === "") errors.name = "setup.persona.required";
  if (!isTimeZone(draft.timezone.trim())) errors.timezone = "settings.form.invalid.timezone";
  return errors;
}

/** POST personas' body; a blank short name or fans word gets the bot's own default. */
export function createRequest(draft: PersonaDraft, voiceId: string): CreatePersonaRequest {
  const name = draft.name.trim();
  return {
    id: draft.id.trim(),
    name,
    shortName: draft.shortName.trim() || name,
    fans: draft.fans.trim() || DEFAULT_FANS,
    summary: draft.summary.trim(),
    timezone: draft.timezone.trim(),
    voiceId,
  };
}

export interface MemoryStepState {
  /** Memory is enabled: turned on during this visit, in settings.yaml, or by status. */
  readonly on: boolean;
  /** The environment sets MEM0_ENABLED, so the step can't change it. */
  readonly fromEnv: boolean;
}

/** What the memory step offers: continuing once memory is on or locked by env, else turning it on. */
export function memoryStepAction({ on, fromEnv }: MemoryStepState): "next" | "turn-on" {
  return on || fromEnv ? "next" : "turn-on";
}
