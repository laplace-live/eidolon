// The accounts a role can name. credentials.json's `accounts` define them; every provider also has
// a default account under its own id, which its variables configure (key, API base, settings), so
// an environment like production's needs no file. The environment wins over the file.
import {
  type AccountEntry,
  accountEntries,
  envOptional,
  envOverride,
  pyStrip,
} from "@eidolon/config";
import { PROVIDERS, type Provider, providerById } from "./catalog.ts";

/** A variable as the bot reads it: environment and settings files layered, blank as unset. */
export type Read = (name: string) => string | undefined;

/** What a resolver reads. A bare Read stands for all of it, the environment included. */
export interface Sources {
  /** Variables, environment over settings files over credentials.json's variables. */
  readonly read: Read;
  /** The environment alone, which wins over an account's own values. */
  readonly env: Read;
  readonly accounts: ReadonlyMap<string, AccountEntry>;
}

/** Where an account's key, API base or setting comes from. */
export type ValueSource = "account" | "env" | "credentials" | "settings" | "default";

export interface Account {
  readonly id: string;
  readonly provider: Provider;
  readonly name: string;
  /** Its id is its provider's, so the provider's variables configure it too. */
  readonly isDefault: boolean;
  /** credentials.json holds an entry for it. */
  readonly saved: boolean;
  readonly apiKey: string | undefined;
  readonly keySource: ValueSource | null;
  /** The HTTP API base its requests go to; undefined for a provider whose clients know theirs. */
  readonly baseUrl: string | undefined;
  readonly baseSource: ValueSource | null;
  /** The provider's own settings, by field key. */
  readonly options: Readonly<Record<string, string>>;
  readonly optionSources: Readonly<Record<string, ValueSource>>;
}

/** `value` stripped, as Python strips it; blank reads as unset. */
export const clean = (value: string | undefined): string | undefined => {
  const text = value === undefined ? undefined : pyStrip(value);
  return text ? text : undefined;
};

export function installedSources(): Sources {
  return { read: envOptional, env: envOverride, accounts: accountEntries() };
}

export function sourcesOf(read?: Read | Sources): Sources {
  if (read === undefined) return installedSources();
  if (typeof read === "function") return { read, env: read, accounts: new Map() };
  return read;
}

/** The first of the layers that has a value, and which one. */
function firstOf(
  layers: readonly [ValueSource, string | null | undefined][],
): [string, ValueSource] | null {
  for (const [source, value] of layers) {
    const set = value === null ? undefined : clean(value);
    if (set !== undefined) return [set, source];
  }
  return null;
}

/** The account `id` names: credentials.json's, or a provider's default; undefined when neither. */
export function accountOf(id: string, read?: Read | Sources): Account | undefined {
  const sources = sourcesOf(read);
  const entry = sources.accounts.get(id);
  const provider = providerById(entry?.provider ?? id);
  if (provider === undefined) return undefined;
  // A provider's id belongs to its default account: an entry under it for another provider is void.
  if (entry !== undefined && providerById(id) !== undefined && entry.provider !== id) {
    return undefined;
  }
  const isDefault = provider.id === id;
  const variable = (name: string | null): [ValueSource, string | undefined][] => {
    if (!isDefault || name === null) return [];
    const env = sources.env(name);
    return [["env", env]];
  };
  // A provider variable from the files, where the environment didn't set it.
  const filed = (name: string | null, source: ValueSource): [ValueSource, string | undefined][] =>
    isDefault && name !== null ? [[source, sources.read(name)]] : [];

  const key = firstOf([
    ...variable(provider.credential),
    ["account", entry?.apiKey],
    ...filed(provider.credential, "credentials"),
  ]);
  const base = firstOf([
    ...variable(provider.baseUrlEnv),
    ["account", entry?.baseUrl],
    ...filed(provider.baseUrlEnv, "settings"),
    ["default", provider.baseUrl],
  ]);
  const options: Record<string, string> = {};
  const optionSources: Record<string, ValueSource> = {};
  for (const field of provider.fields ?? []) {
    const value = firstOf([
      ...variable(field.env),
      ["account", entry?.options[field.key]],
      ...filed(field.env, "settings"),
    ]);
    if (value !== null) {
      options[field.key] = value[0];
      optionSources[field.key] = value[1];
    }
  }
  return {
    id,
    provider,
    name: entry?.name ?? (isDefault ? provider.name : `${provider.name} (${id})`),
    isDefault,
    saved: entry !== undefined,
    apiKey: key?.[0],
    keySource: key?.[1] ?? null,
    baseUrl: base?.[0],
    baseSource: base?.[1] ?? null,
    options,
    optionSources,
  };
}

/**
 * Every account there is to pick: credentials.json's, and each provider's default that its
 * variables configure, in catalog order, a provider's default first.
 */
export function listAccounts(read?: Read | Sources): Account[] {
  const sources = sourcesOf(read);
  const accounts: Account[] = [];
  for (const provider of PROVIDERS) {
    const fallback = accountOf(provider.id, sources);
    if (
      fallback !== undefined &&
      (fallback.saved ||
        fallback.keySource !== null ||
        (fallback.baseSource !== null && fallback.baseSource !== "default") ||
        Object.keys(fallback.options).length > 0)
    ) {
      accounts.push(fallback);
    }
    for (const [id, entry] of sources.accounts) {
      if (id === provider.id || entry.provider !== provider.id) continue;
      const account = accountOf(id, sources);
      if (account !== undefined) accounts.push(account);
    }
  }
  return accounts;
}
