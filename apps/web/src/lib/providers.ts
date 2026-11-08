// The provider catalog as the pages use it: which providers can fill a role, the defaults that apply
// when a persona names none, and the provider an account stands for.
import {
  type Category,
  defaultModel,
  defaultVoice,
  modelInfo,
  PROVIDERS,
  type Provider,
  providerById,
  ROLES,
  type Role,
  type RoleId,
  roleById,
} from "@eidolon/providers/catalog";

export type { Category, Provider, Role, RoleId };
export { defaultModel, defaultVoice, modelInfo, PROVIDERS, providerById, ROLES, roleById };

/** The role whose provider row is `env`, such as LLM_PROVIDER's mind. */
export function roleOfProviderEnv(env: string): Role | undefined {
  return ROLES.find((role) => role.providerEnv === env);
}

/** The role whose model row is `env`. */
export function roleOfModelEnv(env: string): Role | undefined {
  return ROLES.find((role) => role.modelEnv === env);
}

/** A provider's display name, or the id as typed when the catalog has none. */
export function providerName(id: string | null | undefined): string {
  return (id ? providerById(id)?.name : undefined) ?? id ?? "";
}

/** The provider an account id stands for: its own, else the id's where it names a provider. */
export function providerOfAccount(
  id: string | null,
  accounts: readonly { readonly id: string; readonly provider: string }[] | undefined,
): string | null {
  if (id === null) return null;
  return accounts?.find((account) => account.id === id)?.provider ?? (providerById(id) ? id : null);
}
