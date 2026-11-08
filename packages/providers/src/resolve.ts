// Which account, provider and model fill a role, with which key and API base, as the settings say
// now. Every caller that spends money resolves its role here, so a persona's choices reach each one.
import { type Account, accountOf, clean, type Read, type Sources, sourcesOf } from "./accounts.ts";
import {
  CALL_ROLES,
  type Category,
  defaultModel,
  defaultVoice,
  LEGACY_VOICE_ENV,
  type Offer,
  type Provider,
  REALTIME_VOICE_ENV,
  type Role,
  type RoleId,
  roleById,
  VOICE_ENV,
} from "./catalog.ts";

/** The settings name an account that doesn't exist, can't fill the role, or lacks a model. */
export class ProviderConfigError extends Error {
  override name = "ProviderConfigError";
}

export interface Selection {
  readonly role: Role;
  readonly account: Account;
  readonly provider: Provider;
  readonly offer: Offer;
  readonly model: string;
  /** The variable the key comes from, for a provider's default account; null otherwise. */
  readonly keyName: string | null;
  /** Unset when the key is missing; check `hasKey` before a request. */
  readonly apiKey: string | undefined;
  /** The HTTP API base; undefined for a provider whose clients know their own endpoints. */
  readonly baseUrl: string | undefined;
  /** The provider's own settings, by field key. */
  readonly options: Readonly<Record<string, string>>;
}

const CATEGORY_NAMES: Readonly<Record<Category, string>> = {
  llm: "chat model",
  stt: "live speech recognition",
  tts: "speech synthesis",
  realtime: "realtime voice model",
  embedding: "embedding model",
  rerank: "reranker",
  decision: "decision model",
  image: "image model",
  transcription: "transcription",
};

/** The account filling `role`, or null for an optional role nobody turned on. */
export function selectedAccount(role: Role, read?: Read | Sources): Account | null {
  const sources = sourcesOf(read);
  const named = clean(sources.read(role.providerEnv))?.toLowerCase();
  if (named === undefined && role.follows !== undefined) {
    return selectedAccount(roleById(role.follows), sources);
  }
  const id = named ?? role.defaultProvider;
  if (id === null) return null;
  const account = accountOf(id, sources);
  if (account === undefined) {
    throw new ProviderConfigError(
      `${role.providerEnv}=${id} is no provider or account Eidolon knows`,
    );
  }
  if (account.provider.offers[role.category] === undefined) {
    throw new ProviderConfigError(
      `${account.name} offers no ${CATEGORY_NAMES[role.category]} (${role.providerEnv})`,
    );
  }
  return account;
}

function modelFor(role: Role, provider: Provider, sources: Sources): string | undefined {
  const own = clean(sources.read(role.modelEnv));
  if (own !== undefined) return own;
  const legacy = role.legacyModelEnv;
  if (legacy !== undefined && legacy.provider === provider.id) {
    const value = clean(sources.read(legacy.env));
    if (value !== undefined) return value;
  }
  // A role that follows another takes its model too, while both use the same provider.
  if (role.follows !== undefined) {
    const followed = roleById(role.follows);
    if (selectedAccount(followed, sources)?.provider.id === provider.id) {
      return modelFor(followed, provider, sources);
    }
  }
  return undefined;
}

/** `role` as the settings fill it now; null for an optional role that is off. */
export function select(roleId: RoleId, read?: Read | Sources): Selection | null {
  const sources = sourcesOf(read);
  const role = roleById(roleId);
  const account = selectedAccount(role, sources);
  if (account === null) return null;
  const { provider } = account;
  const offer = provider.offers[role.category] as Offer;
  const model = modelFor(role, provider, sources) ?? defaultModel(role, provider.id);
  if (model === null) {
    throw new ProviderConfigError(`${account.name} needs a model: set ${role.modelEnv}`);
  }
  // A role's own key and API base move the one route it had before accounts, its default
  // provider's own account; an account picked for it brings its own.
  const own = account.id === role.defaultProvider;
  const roleKey = own && role.keyEnv !== undefined ? clean(sources.read(role.keyEnv)) : undefined;
  const roleBase =
    own && role.baseUrlEnv !== undefined ? clean(sources.read(role.baseUrlEnv)) : undefined;
  const keyName =
    roleKey !== undefined
      ? (role.keyEnv as string)
      : account.isDefault
        ? provider.credential
        : null;
  const baseUrl = roleBase ?? account.baseUrl;
  if (baseUrl === undefined && provider.baseUrlEnv !== null) {
    throw new ProviderConfigError(
      account.isDefault
        ? `${provider.name} needs an API base: set ${provider.baseUrlEnv}`
        : `The ${account.name} account needs an API base: set it in Settings → Providers`,
    );
  }
  return {
    role,
    account,
    provider,
    offer,
    model,
    keyName,
    apiKey: roleKey ?? account.apiKey,
    baseUrl,
    options: account.options,
  };
}

/** `select` for a role the caller can't run without: null becomes an error too. */
export function selectRequired(roleId: RoleId, read?: Read | Sources): Selection {
  const selection = select(roleId, read);
  if (selection === null) {
    throw new ProviderConfigError(`No provider fills ${roleById(roleId).providerEnv}`);
  }
  return selection;
}

/**
 * `select` for a role that may stay off: settings naming an account that can't fill it read as off
 * too, once `onError` hears why.
 */
export function trySelect(
  roleId: RoleId,
  read?: Read | Sources,
  onError?: (error: ProviderConfigError) => void,
): Selection | null {
  try {
    return select(roleId, read);
  } catch (error) {
    if (!(error instanceof ProviderConfigError)) throw error;
    onError?.(error);
    return null;
  }
}

/** Whether a provider asks every request for a key. */
export function takesKey(provider: Provider): boolean {
  return provider.credential !== null && provider.keyOptional !== true;
}

/** Whether a request can go out: a key is set, or the provider takes none. */
export function hasKey(selection: Selection): boolean {
  return !takesKey(selection.provider) || selection.apiKey !== undefined;
}

/** The error a missing key reports, naming where it goes. */
export function missingKey(selection: Selection): ProviderConfigError {
  const { account, provider, keyName, role } = selection;
  if (keyName === null) {
    return new ProviderConfigError(
      `The ${account.name} account has no API key: add it in Settings → Providers`,
    );
  }
  const alone =
    role.keyEnv !== undefined && role.keyEnv !== keyName && account.id === role.defaultProvider
      ? `, or ${role.keyEnv} for ${role.label} alone`
      : "";
  return new ProviderConfigError(
    `${provider.name} needs an API key: set ${keyName} in credentials.json or the environment${alone}`,
  );
}

/** The TTS voice: TTS_VOICE_ID, Fish's FISH_VOICE_ID while Fish speaks, else the provider's own. */
export function voiceOf(selection: Selection, read?: Read | Sources): string | undefined {
  const sources = sourcesOf(read);
  const own = clean(sources.read(VOICE_ENV));
  if (own !== undefined) return own;
  if (selection.provider.id === "fish") {
    const legacy = clean(sources.read(LEGACY_VOICE_ENV));
    if (legacy !== undefined) return legacy;
  }
  return defaultVoice(selection.offer);
}

/** The realtime model's voice: REALTIME_VOICE, else the provider's default. */
export function realtimeVoiceOf(selection: Selection, read?: Read | Sources): string | undefined {
  const own = clean(sourcesOf(read).read(REALTIME_VOICE_ENV));
  return own ?? defaultVoice(selection.offer);
}

/** The roles a call runs on: one realtime model, or hearing, mind and voice. */
export function callRoles(read?: Read | Sources): readonly RoleId[] {
  return selectedAccount(roleById("realtime"), read) === null ? CALL_ROLES : ["realtime"];
}

export interface AccountNeed {
  readonly account: Account;
  readonly roles: readonly RoleId[];
  /** Its key is set, or its provider takes none. */
  readonly set: boolean;
}

/**
 * The accounts `roles` need a key for, one entry each, in the roles' order. A role whose settings
 * name no account Eidolon knows is left out: its error is the problem to report, not a key.
 */
export function accountsFor(roles: readonly RoleId[], read?: Read | Sources): AccountNeed[] {
  const sources = sourcesOf(read);
  const needs = new Map<string, { account: Account; roles: RoleId[]; set: boolean }>();
  for (const roleId of roles) {
    const selection = trySelect(roleId, sources);
    if (selection === null || !takesKey(selection.provider)) continue;
    const entry = needs.get(selection.account.id);
    if (entry === undefined) {
      needs.set(selection.account.id, {
        account: selection.account,
        roles: [roleId],
        set: hasKey(selection),
      });
    } else {
      entry.roles.push(roleId);
    }
  }
  return [...needs.values()];
}
