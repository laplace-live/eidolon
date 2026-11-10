// The setup wizard's steps, and what it decides from the API's answers.
import {
  type AccountList,
  effectiveProviderType,
  isTimeZone,
} from "@/components/settings-form/controls";
import type { AccountView, CreatePersonaRequest, SettingRow, Status } from "@/lib/api";
import { roleById } from "@/lib/providers";

export const STEPS = ["keys", "persona", "voice", "memory", "done"] as const;
export type Step = (typeof STEPS)[number];

export function isStep(value: unknown): value is Step {
  return (STEPS as readonly unknown[]).includes(value);
}

/** Where the wizard opens: the keys while one is missing, else the step a link asked for. */
export function firstStep(status: Pick<Status, "keys">, requested: string | null): Step {
  if (status.keys.some((key) => !key.set)) return "keys";
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
 * The provider a persona speaks through when it isn't Fish Audio, whose library the voice step
 * searches; null for Fish. Another provider's voice stays as she has it.
 */
export function otherVoiceProvider(
  rows: readonly SettingRow[],
  accounts: AccountList | undefined,
): string | null {
  const provider = effectiveProviderType(roleById("voice"), rows, {}, accounts);
  return provider === null || provider === "fish" ? null : provider;
}

/** Ids become folder names, lock keys and --persona, so they stay lowercase ASCII. */
export const PERSONA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The admin API's literal path words, which the server refuses as ids: they would read as routes. */
export const RESERVED_IDS: ReadonlySet<string> = new Set([
  "accounts",
  "active",
  "api",
  "avatar",
  "batches",
  "chats",
  "check",
  "credentials",
  "events",
  "facts",
  "files",
  "glossary",
  "identity",
  "index",
  "jobs",
  "live",
  "local",
  "log",
  "memories",
  "messages",
  "models",
  "personas",
  "prompt",
  "references",
  "restart",
  "resume",
  "search",
  "session",
  "settings",
  "status",
  "stop",
  "usage",
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

export const QDRANT_IMAGE = "qdrant/qdrant:v1.19.1";
export const QDRANT_HOST = "127.0.0.1";
export const QDRANT_PORT = 6333;

export interface QdrantAddress {
  readonly host: string;
  readonly port: number;
}

/** The address settings.yaml gives memory, as the step shows it; null when it names no host. */
export function savedQdrant(host: unknown, port: unknown): QdrantAddress | null {
  if (typeof host !== "string" || host.trim() === "") return null;
  return { host: host.trim(), port: typeof port === "number" ? port : QDRANT_PORT };
}

export interface MemoryStepState {
  /** Memory answers: checked on this visit, or by the last status. */
  readonly on: boolean;
  /** The environment sets the address, so the fields can't change it. */
  readonly fromEnv: boolean;
  /** Where memory runs: what this visit saved, else what settings.yaml holds. */
  readonly saved: QdrantAddress | null;
  /** The fields' address; null while the port doesn't parse. */
  readonly typed: QdrantAddress | null;
}

/**
 * What the memory step offers: going on while memory is on at the address shown, else checking
 * the typed address and saving it, which a changed address needs again once memory is on.
 */
export function memoryStepAction({ on, fromEnv, saved, typed }: MemoryStepState): "next" | "check" {
  if (!on) return "check";
  if (fromEnv) return "next";
  const same =
    saved !== null && typed !== null && saved.host === typed.host && saved.port === typed.port;
  return same ? "next" : "check";
}

/**
 * Qdrant has no auth, so it publishes on loopback only, with CORS off so no web page can reach
 * it; a named volume keeps the memories across container upgrades.
 */
export const QDRANT_COMMAND = [
  "docker run -d --name eidolon-qdrant --restart unless-stopped",
  `-p ${QDRANT_HOST}:${QDRANT_PORT}:6333`,
  "-v eidolon-qdrant:/qdrant/storage",
  "-e QDRANT__SERVICE__ENABLE_CORS=false",
  "-e QDRANT__TELEMETRY_DISABLED=true",
  QDRANT_IMAGE,
].join(" ");
