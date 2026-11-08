// Provider accounts: credentials.json's `accounts`, each a provider with its key, its API base and
// the provider's own settings. An account whose id is its provider's is that provider's default,
// which the provider's variables also configure; any other id is one more account of it.
import { isPlainObject } from "./py.ts";

export interface AccountEntry {
  readonly id: string;
  /** The catalog id of its provider. */
  readonly provider: string;
  readonly name: string | null;
  readonly apiKey: string | null;
  readonly baseUrl: string | null;
  /** The provider's own settings, such as MiniMax's group id. */
  readonly options: Readonly<Record<string, string>>;
}

/** credentials.json's key for them; every other key is a variable. */
export const ACCOUNTS_KEY = "accounts";

const ACCOUNT_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const FIELDS = new Set(["provider", "name", "apiKey", "baseUrl", "options"]);

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** credentials.json's `accounts`, by id; what can't be one is warned about and left out. */
export function parseAccounts(
  raw: unknown,
  label: string,
  warn: (message: string) => void,
): Map<string, AccountEntry> {
  const accounts = new Map<string, AccountEntry>();
  if (raw === undefined || raw === null) return accounts;
  if (!isPlainObject(raw)) {
    warn(`Ignoring ${ACCOUNTS_KEY} in ${label}: expected a mapping of id to account`);
    return accounts;
  }
  for (const [id, value] of Object.entries(raw)) {
    if (!isAccountId(id)) {
      warn(`Ignoring account ${JSON.stringify(id)} in ${label}: an id is a lowercase slug`);
      continue;
    }
    const provider = isPlainObject(value) ? text(value.provider) : null;
    if (!isPlainObject(value) || provider === null) {
      warn(`Ignoring account ${id} in ${label}: it names no provider`);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!FIELDS.has(key))
        warn(`Ignoring ${key} of account ${id} in ${label}: not an account field`);
    }
    const options: Record<string, string> = {};
    if (isPlainObject(value.options)) {
      for (const [key, option] of Object.entries(value.options)) {
        const set = text(option);
        if (set !== null) options[key] = set;
      }
    }
    accounts.set(id, {
      id,
      provider: provider.toLowerCase(),
      name: text(value.name),
      apiKey: text(value.apiKey),
      baseUrl: text(value.baseUrl),
      options,
    });
  }
  return accounts;
}

/** The provider an account id stands for: its entry's, else the id itself, a provider's default. */
export function accountProvider(id: string, accounts: ReadonlyMap<string, AccountEntry>): string {
  return accounts.get(id)?.provider ?? id;
}
