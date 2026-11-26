// The keys step's choices: what can fill each role it asks about, the model each would run, and
// the keys the chosen accounts need.
import type { KeyTier } from "@/components/settings-form/account-key-field";
import {
  type AccountList,
  effectiveModel,
  effectiveProvider,
  effectiveProviderType,
  fallbackModel,
  orphanedByProvider,
  strip,
} from "@/components/settings-form/controls";
import type { AccountView, SettingRow } from "@/lib/api";
import {
  CALL_ROLES,
  providerById,
  providerOfAccount,
  providersFor,
  type Role,
  type RoleId,
  roleById,
  SETUP_ROLES,
} from "@/lib/providers";
import { RECOMMENDED_ROLES } from "./first-run";

export type PickedRole = (typeof SETUP_ROLES)[number];

/** Whether a call can't run without `role`. */
export function callNeeds(role: RoleId): boolean {
  return CALL_ROLES.includes(role);
}

/**
 * Optional roles the step doesn't pick for, whose accounts it still lists keys for: they run on
 * the accounts her settings name (or their defaults).
 */
export const RIDERS = [
  "rerank",
  "selfie",
  "assistant",
  "search",
] as const satisfies readonly RoleId[];

export interface Choice {
  /** The account it names; a provider's id names its default account. */
  readonly account: string;
  readonly name: string;
  readonly recommended: boolean;
}

type Listed = readonly Pick<AccountView, "id" | "provider" | "name">[];

/**
 * What can fill `role`: every provider that offers it, as its default account, with the other
 * accounts Settings has of it, the recommended one first. A provider whose API base is the user's
 * own server is listed only once an account of it is set up; `current` always is.
 */
export function choicesFor(
  role: Role,
  accounts: Listed | undefined,
  current: string | null,
): Choice[] {
  const listed = accounts ?? [];
  const choices: Choice[] = [];
  for (const provider of providersFor(role.category)) {
    const own = listed.filter((account) => account.provider === provider.id);
    const fallback = own.find((account) => account.id === provider.id);
    if (fallback !== undefined || provider.baseUrl !== null) {
      choices.push({
        account: provider.id,
        name: fallback?.name ?? provider.name,
        recommended: provider.id === role.defaultProvider,
      });
    }
    for (const account of own) {
      if (account.id === provider.id) continue;
      choices.push({ account: account.id, name: account.name, recommended: false });
    }
  }
  if (current !== null && !choices.some((choice) => choice.account === current)) {
    choices.push({ account: current, name: current, recommended: false });
  }
  return [...choices.filter((c) => c.recommended), ...choices.filter((c) => !c.recommended)];
}

type Rows = readonly Pick<SettingRow, "path" | "value" | "envValue" | "envOverride">[];

/**
 * The model `role` runs on once the drafts are saved: one typed for it, else hers unless the drafts
 * move her to another provider, else that provider's default; null when it needs one named.
 */
export function modelAfter(
  role: Role,
  rows: Rows,
  drafts: Readonly<Record<string, string>>,
  accounts: AccountList | undefined,
): string | null {
  const typed = strip(drafts[`${role.path}.model`] ?? "");
  if (typed !== "") return typed;
  const moved =
    effectiveProviderType(role, rows, {}, accounts) !==
    effectiveProviderType(role, rows, drafts, accounts);
  return moved
    ? fallbackModel(role, rows, drafts, accounts)
    : effectiveModel(role, rows, drafts, accounts);
}

/**
 * The row whose environment value holds `role`'s pick: its provider's, or its model's, which would
 * go to whichever provider the pick moves it to.
 */
export function envLock<R extends Pick<SettingRow, "path" | "envOverride">>(
  role: Role,
  rows: readonly R[],
): R | undefined {
  const paths = [`${role.path}.provider`, `${role.path}.model`];
  return rows.find((row) => row.envOverride && paths.includes(row.path));
}

/** What saving the drafts writes, split by the file each value lives in. */
export interface PickChanges {
  readonly persona: Readonly<Record<string, unknown>>;
  readonly app: Readonly<Record<string, unknown>>;
}

/**
 * Each picked role's account where the drafts change it, each model typed, and null for every
 * model and voice that belonged to a provider the drafts replace. Rows the environment locks are
 * left alone.
 */
export function pickChanges(
  rows: readonly SettingRow[],
  drafts: Readonly<Record<string, string>>,
  accounts: AccountList | undefined,
): PickChanges {
  const values: Record<string, unknown> = {};
  for (const [path, draft] of Object.entries(drafts)) {
    const row = rows.find((candidate) => candidate.path === path);
    if (row === undefined || row.envOverride) continue;
    const value = strip(draft);
    const role = SETUP_ROLES.map(roleById).find((entry) => `${entry.path}.provider` === path);
    if (role === undefined) {
      if (value !== "") values[path] = value;
    } else if (value !== effectiveProvider(role, rows, {})) {
      values[path] = value;
    }
  }
  for (const path of orphanedByProvider(rows, drafts, values, accounts)) values[path] = null;
  const persona: Record<string, unknown> = {};
  const app: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(values)) {
    const scope = rows.find((row) => row.path === path)?.scope;
    if (scope === "app") app[path] = value;
    else persona[path] = value;
  }
  return { persona, app };
}

export interface KeyNeed {
  readonly account: string;
  /** As Settings names it, else its provider's name. */
  readonly name: string;
  readonly provider: string;
  readonly roles: readonly RoleId[];
  /** Whether it takes a key: always, where its server asks for one, or never. */
  readonly key: "required" | "optional" | "none";
  /**
   * The most any role it serves asks of its key, when it always takes one: required for her mind
   * or a realtime model, recommended for her hearing or voice; else optional.
   */
  readonly tier: KeyTier;
  /** Its key is set, wherever: saved, in credentials.json, or in the environment. */
  readonly set: boolean;
}

/** From the least a key's roles ask of it to the most. */
const TIERS: readonly KeyTier[] = ["optional", "recommended", "required"];

/** One role and the account the drafts give it; `call` when a call can't run without it. */
export interface Picked {
  readonly role: RoleId;
  readonly account: string | null;
  readonly call: boolean;
}

/**
 * The accounts `picked` names, one each in the roles' order. An account Eidolon doesn't know is left
 * out: the role's problem is GET status's to report, not a key.
 */
export function keyNeeds(
  picked: readonly Picked[],
  accounts: readonly Pick<AccountView, "id" | "provider" | "name" | "key">[] | undefined,
): KeyNeed[] {
  type Entry = Omit<KeyNeed, "roles" | "tier"> & { roles: RoleId[]; tier: KeyTier };
  const needs = new Map<string, Entry>();
  for (const { role, account, call } of picked) {
    if (account === null) continue;
    const id = providerOfAccount(account, accounts);
    const provider = id === null ? undefined : providerById(id);
    if (provider === undefined) continue;
    const key =
      provider.credential === null ? "none" : provider.keyOptional ? "optional" : "required";
    const tier: KeyTier =
      !call || key !== "required"
        ? "optional"
        : RECOMMENDED_ROLES.has(role)
          ? "recommended"
          : "required";
    const known = needs.get(account);
    if (known !== undefined) {
      known.roles.push(role);
      if (TIERS.indexOf(tier) > TIERS.indexOf(known.tier)) known.tier = tier;
      continue;
    }
    const listed = accounts?.find((entry) => entry.id === account);
    needs.set(account, {
      account,
      name: listed?.name ?? provider.name,
      provider: provider.id,
      roles: [role],
      key,
      tier,
      set: key === "none" || (listed?.key.source ?? null) !== null,
    });
  }
  return [...needs.values()];
}

/**
 * The provider's own settings `need`'s account lacks, such as MiniMax's group id: set nowhere and
 * not typed in `typed`, by field key.
 */
export function missingFields(
  need: Pick<KeyNeed, "account" | "provider">,
  accounts: readonly Pick<AccountView, "id" | "options">[] | undefined,
  typed: Readonly<Record<string, string>> | undefined,
): string[] {
  const account = accounts?.find((entry) => entry.id === need.account);
  return (providerById(need.provider)?.fields ?? [])
    .filter((field) => (account?.options[field.key]?.value ?? null) === null)
    .filter((field) => (typed?.[field.key] ?? "").trim() === "")
    .map((field) => field.key);
}
