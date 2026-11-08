// /api/local/accounts: the provider accounts a role can name, credentials.json's and each
// provider's default. Keys never go back out. An account is checked against its provider, and
// lists the models its provider's API offers.
import {
  ACCOUNTS_KEY,
  envOptional,
  envOverride,
  isAccountId,
  isPlainObject,
  personaIds,
  readSettingsLayers,
} from "@eidolon/config";
import {
  type Account,
  accountOf,
  accountsFor,
  CATEGORIES,
  type Category,
  callRoles,
  installedSources,
  listAccounts,
  listModels,
  type ModelListing,
  PROVIDERS,
  type Provider,
  providerById,
  ROLES,
} from "@eidolon/providers";
import type { AccountUse, AccountValue, AccountView, CheckResult, ModelsResponse } from "../api.ts";
import { type CheckDeps, checkAccount } from "../checks.ts";
import { localError, localJson, readJson } from "../responses.ts";
import { reinstallSettings } from "../restart.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";
import { recordVoice } from "../status.ts";
import { typedValue, writableCredentials, writeCredentials } from "./credentials.ts";

const MAX_NAME_CHARS = 80;
/** How long a listing answers again from memory; a failure is asked again sooner. */
const LISTING_TTL_MS = 10 * 60 * 1000;
const FAILED_TTL_MS = 30 * 1000;

/** Every settings file that names an account for a role, by account id. */
function accountUses(): Map<string, AccountUse[]> {
  const uses = new Map<string, AccountUse[]>();
  const add = (id: string, use: AccountUse) => {
    const list = uses.get(id) ?? [];
    list.push(use);
    uses.set(id, list);
  };
  let appDone = false;
  for (const persona of personaIds()) {
    const layers = readSettingsLayers(persona);
    for (const role of ROLES) {
      const named = layers.values.get(role.providerEnv);
      const id = named?.value?.trim().toLowerCase();
      if (!id) continue;
      if (named?.source === "persona") add(id, { persona, role: role.id });
      else if (named?.source === "app" && !appDone) add(id, { persona: null, role: role.id });
    }
    appDone = true;
  }
  return uses;
}

function view(account: Account, uses: Map<string, AccountUse[]>, needed: Set<string>): AccountView {
  const options: Record<string, AccountValue> = {};
  for (const field of account.provider.fields ?? []) {
    options[field.key] = {
      value: account.options[field.key] ?? null,
      source: account.optionSources[field.key] ?? null,
    };
  }
  return {
    id: account.id,
    provider: account.provider.id,
    name: account.name,
    isDefault: account.isDefault,
    saved: account.saved,
    key: { value: null, source: account.keySource },
    baseUrl: { value: account.baseUrl ?? null, source: account.baseSource },
    options,
    uses: uses.get(account.id) ?? [],
    needed: needed.has(account.id),
  };
}

function neededAccounts(): Account[] {
  try {
    return accountsFor(callRoles()).map((need) => need.account);
  } catch {
    // Settings that name no account Eidolon knows are GET status's problem to report.
    return [];
  }
}

/** Every account to show: the ones there are, and the defaults the active persona's calls need. */
export function accountViews(): AccountView[] {
  const uses = accountUses();
  const needs = neededAccounts();
  const needed = new Set(needs.map((account) => account.id));
  const byId = new Map(listAccounts().map((account) => [account.id, account]));
  for (const account of needs) if (!byId.has(account.id)) byId.set(account.id, account);
  const order = (account: Account) => PROVIDERS.indexOf(account.provider);
  return [...byId.values()]
    .sort(
      (a, b) =>
        order(a) - order(b) ||
        Number(b.isDefault) - Number(a.isDefault) ||
        a.id.localeCompare(b.id),
    )
    .map((account) => view(account, uses, needed));
}

function accountView(id: string): AccountView | null {
  const account = accountOf(id);
  if (account === undefined) return null;
  return view(account, accountUses(), new Set(neededAccounts().map((need) => need.id)));
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

const bad = (message: string): Parsed<never> => ({
  ok: false,
  response: localError(400, "bad-request", message),
});

/** An account's name: one line of at most 80 characters. */
function nameOf(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  const name = typedValue(raw);
  return name === null || name.length > MAX_NAME_CHARS ? undefined : name;
}

/**
 * An API base: http or https, with no user, password, query or fragment. GET accounts shows the
 * base, so a key typed into it would go back out.
 */
function baseOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Whether an account of `provider` can take an API base: where a variable moves its default's. The
 * rest stream from hosts of their own, which a base wouldn't reach.
 */
function movesBase(provider: Provider): boolean {
  return provider.baseUrlEnv !== null;
}

interface Changes {
  readonly name?: string | null;
  readonly apiKey?: string | null;
  readonly baseUrl?: string | null;
  readonly options: Readonly<Record<string, string | null>>;
}

/** A body's fields for `provider`'s account, checked; what it leaves out stays as it is. */
function parseChanges(
  body: Readonly<Record<string, unknown>>,
  provider: Provider,
): Parsed<Changes> {
  const changes: { -readonly [K in keyof Changes]: Changes[K] } = { options: {} };
  if (body.name !== undefined) {
    const name = nameOf(body.name);
    if (name === undefined) return bad("A name is one line of at most 80 characters");
    changes.name = name;
  }
  if (body.apiKey !== undefined) {
    const key = body.apiKey === null ? null : typedValue(body.apiKey);
    if (body.apiKey !== null && key === null) return bad("A key is one line of text");
    changes.apiKey = key;
  }
  if (body.baseUrl !== undefined) {
    const raw = body.baseUrl === null ? null : typedValue(body.baseUrl);
    const base = raw === null ? null : baseOf(raw);
    if (body.baseUrl !== null && base === null) return bad("An API base is an http(s) URL");
    if (base !== null && !movesBase(provider)) return bad(`${provider.name} takes no API base`);
    changes.baseUrl = base;
  }
  if (body.options !== undefined) {
    if (!isPlainObject(body.options)) return bad("Send options as {field: value or null}");
    const fields = new Set((provider.fields ?? []).map((field) => field.key));
    const options: Record<string, string | null> = {};
    for (const [key, raw] of Object.entries(body.options)) {
      if (!fields.has(key)) return bad(`${provider.name} takes no setting by that name`);
      const set = raw === null ? null : typedValue(raw);
      if (raw !== null && set === null) return bad("A setting is one line of text");
      options[key] = set;
    }
    changes.options = options;
  }
  return { ok: true, value: changes };
}

/** Writes `id`'s entry, as `changes` leave it, into the file credentials.json holds. */
function applyChanges(
  saved: Record<string, unknown>,
  id: string,
  provider: Provider,
  changes: Changes,
): void {
  const accounts = isPlainObject(saved[ACCOUNTS_KEY]) ? { ...saved[ACCOUNTS_KEY] } : {};
  const before = isPlainObject(accounts[id]) ? accounts[id] : {};
  const entry: Record<string, unknown> = { ...before, provider: provider.id };
  const set = (key: string, next: string | null | undefined) => {
    if (next === undefined) return;
    if (next === null) delete entry[key];
    else entry[key] = next;
  };
  set("name", changes.name);
  set("apiKey", changes.apiKey);
  set("baseUrl", changes.baseUrl);
  const options = isPlainObject(entry.options) ? { ...entry.options } : {};
  for (const [key, next] of Object.entries(changes.options)) {
    if (next === null) delete options[key];
    else options[key] = next;
  }
  if (Object.keys(options).length > 0) entry.options = options;
  else delete entry.options;
  accounts[id] = entry;
  saved[ACCOUNTS_KEY] = accounts;
  // A default account's entry outranks the file's variable for its key, which would only go stale.
  if (id === provider.id && changes.apiKey !== undefined && provider.credential !== null) {
    delete saved[provider.credential];
  }
}

/** The id a new account of `provider` gets: the provider's own while its default is unset. */
function newId(provider: Provider, saved: Readonly<Record<string, unknown>>): string {
  const accounts = isPlainObject(saved[ACCOUNTS_KEY]) ? saved[ACCOUNTS_KEY] : {};
  const fallback = accountOf(provider.id);
  const unused =
    fallback !== undefined &&
    !fallback.saved &&
    fallback.keySource === null &&
    (fallback.baseSource === null || fallback.baseSource === "default");
  if (unused && !(provider.id in accounts)) return provider.id;
  for (let n = 2; ; n++) {
    const id = `${provider.id}-${n}`;
    if (!(id in accounts) && providerById(id) === undefined) return id;
  }
}

export interface AccountsDeps {
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

const defaultDeps: AccountsDeps = { fetch, now: Date.now };

export function accountsRoutes(app: LocalApp, deps: AccountsDeps = defaultDeps): LocalRouteSpec[] {
  const listings = new Map<string, { at: number; listing: ModelListing }>();
  /** Writes credentials.json, forgets what `id`'s provider listed for it, and applies the file. */
  const commit = (saved: Readonly<Record<string, unknown>>, id: string) => {
    writeCredentials(saved);
    for (const key of listings.keys()) if (key.startsWith(`${id}\0`)) listings.delete(key);
    reinstallSettings(app);
  };
  const checkDeps = (): CheckDeps => ({
    fetch: deps.fetch,
    now: deps.now,
    read: envOptional,
    sources: installedSources(),
    fromEnv: (name) => envOverride(name) !== undefined,
  });
  return [
    {
      route: "GET /api/local/accounts",
      handler: () => localJson(200, { accounts: accountViews() }),
    },
    {
      route: "POST /api/local/accounts",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        if (!isPlainObject(body.value)) return localError(400, "bad-request", "Send an account");
        const provider =
          typeof body.value.provider === "string" ? providerById(body.value.provider) : undefined;
        if (provider === undefined) {
          return localError(400, "unknown-account", "Name a provider Eidolon knows");
        }
        const changes = parseChanges(body.value, provider);
        if (!changes.ok) return changes.response;
        const saved = writableCredentials();
        if (saved instanceof Response) return saved;
        const id = newId(provider, saved);
        applyChanges(saved, id, provider, changes.value);
        commit(saved, id);
        return localJson(201, accountView(id));
      },
    },
    {
      route: "PUT /api/local/accounts/:id",
      async handler(request, { params }) {
        const id = params.id as string;
        const account = isAccountId(id) ? accountOf(id) : undefined;
        if (account === undefined) return localError(404, "unknown-account", "No such account");
        const body = await readJson(request);
        if (!body.ok) return body.response;
        if (!isPlainObject(body.value)) return localError(400, "bad-request", "Send its changes");
        const changes = parseChanges(body.value, account.provider);
        if (!changes.ok) return changes.response;
        const saved = writableCredentials();
        if (saved instanceof Response) return saved;
        applyChanges(saved, id, account.provider, changes.value);
        commit(saved, id);
        return localJson(200, accountView(id));
      },
    },
    {
      route: "DELETE /api/local/accounts/:id",
      handler(_request, { params }) {
        const id = params.id as string;
        const account = isAccountId(id) ? accountOf(id) : undefined;
        if (account === undefined) return localError(404, "unknown-account", "No such account");
        if ((accountUses().get(id) ?? []).length > 0) {
          return localError(409, "account-in-use", "A persona's settings name this account");
        }
        const saved = writableCredentials();
        if (saved instanceof Response) return saved;
        const accounts = isPlainObject(saved[ACCOUNTS_KEY]) ? { ...saved[ACCOUNTS_KEY] } : {};
        delete accounts[id];
        if (Object.keys(accounts).length > 0) saved[ACCOUNTS_KEY] = accounts;
        else delete saved[ACCOUNTS_KEY];
        if (account.isDefault && account.provider.credential !== null) {
          delete saved[account.provider.credential];
        }
        commit(saved, id);
        return localJson(200, { ok: true });
      },
    },
    {
      route: "POST /api/local/accounts/check",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const value = isPlainObject(body.value) ? body.value : {};
        const saved =
          typeof value.account === "string" && isAccountId(value.account)
            ? accountOf(value.account)
            : undefined;
        if (value.account !== undefined && saved === undefined) {
          return localError(404, "unknown-account", "No such account");
        }
        const provider =
          saved?.provider ??
          (typeof value.provider === "string" ? providerById(value.provider) : undefined);
        if (provider === undefined) {
          return localError(400, "unknown-account", "Name an account or a provider to check");
        }
        const typedKey = value.apiKey === undefined ? undefined : typedValue(value.apiKey);
        const typedBase =
          value.baseUrl === undefined
            ? undefined
            : (baseOf(typedValue(value.baseUrl) ?? "") ?? null);
        if (typedKey === null || typedBase === null) {
          return localError(400, "bad-request", "A key is one line, and an API base a URL");
        }
        if (typedBase !== undefined && !movesBase(provider)) {
          return localError(400, "bad-request", `${provider.name} takes no API base`);
        }
        const apiKey = typedKey ?? saved?.apiKey;
        const outcome = await checkAccount(
          {
            provider,
            apiKey,
            baseUrl: typedBase ?? saved?.baseUrl ?? provider.baseUrl ?? undefined,
            ...(saved === undefined ? {} : { account: saved.id }),
          },
          checkDeps(),
          typedKey === undefined && saved?.keySource === "env",
        );
        // What a check of the voice's saved Fish key learned of the voice, GET status shows too.
        if (outcome.voice !== undefined && typedKey === undefined && apiKey !== undefined) {
          recordVoice(app, outcome.voice.id, apiKey, outcome.voice.ok);
        }
        return localJson(200, outcome.result satisfies CheckResult);
      },
    },
    {
      route: "GET /api/local/accounts/:id/models",
      async handler(_request, { params, url }) {
        const id = params.id as string;
        const account = isAccountId(id) ? accountOf(id) : undefined;
        if (account === undefined) return localError(404, "unknown-account", "No such account");
        const category = url.searchParams.get("category") ?? "";
        if (!(CATEGORIES as readonly string[]).includes(category)) {
          return localError(400, "bad-request", "Name a kind of model");
        }
        // Every write to the account forgets its listings, so a new key lists afresh.
        const cacheKey = [id, category, account.baseUrl ?? ""].join("\0");
        const cached = listings.get(cacheKey);
        const now = deps.now();
        let listing: ModelListing;
        if (
          cached !== undefined &&
          now - cached.at <
            (cached.listing.status === "failed" || cached.listing.status === "refused"
              ? FAILED_TTL_MS
              : LISTING_TTL_MS)
        ) {
          listing = cached.listing;
        } else {
          listing = account.provider.offers[category as Category]
            ? await listModels(account, category as Category, { fetch: deps.fetch })
            : { status: "unlisted" };
          listings.set(cacheKey, { at: now, listing });
        }
        return localJson(200, { models: [], ...listing } satisfies ModelsResponse);
      },
    },
  ];
}
