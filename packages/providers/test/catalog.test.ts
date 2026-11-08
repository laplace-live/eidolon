import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CREDENTIALS, SETTINGS } from "@eidolon/config";
import {
  CATEGORIES,
  PROVIDER_IDS,
  PROVIDERS,
  providersFor,
  ROLE_IDS,
  ROLES,
} from "../src/catalog.ts";

describe("the catalog", () => {
  test("imports nothing, so the web app's bundle can carry it", () => {
    const source = readFileSync(new URL("../src/catalog.ts", import.meta.url), "utf8");
    expect(source.match(/^\s*(?:import|export\s+(?:\*|\{[^}]*\})\s+from)\b.*$/gm)).toBeNull();
  });

  test("lists each provider once, in PROVIDER_IDS order", () => {
    expect(PROVIDERS.map((provider) => provider.id)).toEqual([...PROVIDER_IDS]);
  });

  test("every offer's default model is one it lists, unless it takes any", () => {
    for (const provider of PROVIDERS) {
      for (const [category, offer] of Object.entries(provider.offers)) {
        expect(CATEGORIES).toContain(category as (typeof CATEGORIES)[number]);
        const ids = offer.models.map((model) => model.id);
        expect(new Set(ids).size, `${provider.id} ${category}`).toBe(ids.length);
        if (offer.defaultModel !== null && !offer.openModels) {
          expect(ids, `${provider.id} ${category}`).toContain(offer.defaultModel);
        }
      }
    }
  });

  test("every key the catalog names is a credential the settings files take", () => {
    for (const provider of PROVIDERS) {
      if (provider.credential !== null) expect(CREDENTIALS).toContain(provider.credential);
    }
    for (const role of ROLES) if (role.keyEnv) expect(CREDENTIALS).toContain(role.keyEnv);
  });

  test("an API base variable that settings.yaml can also set is an app row under providers.<id>", () => {
    const rows = new Map(SETTINGS.map((row) => [row.env, row]));
    const filed = PROVIDERS.filter(
      (provider) => provider.baseUrlEnv !== null && rows.has(provider.baseUrlEnv),
    );
    expect(filed.map((provider) => provider.id)).toEqual(["openrouter", "openai"]);
    for (const provider of filed) {
      const row = rows.get(provider.baseUrlEnv as string);
      expect(row?.scope, provider.baseUrlEnv as string).toBe("app");
      expect(row?.path.startsWith(`providers.${provider.id}.`)).toBe(true);
    }
  });

  test("every role's settings are rows of its scope, with the role's default provider", () => {
    const rows = new Map(SETTINGS.map((row) => [row.env, row]));
    expect(ROLES.map((role) => role.id)).toEqual([...ROLE_IDS]);
    for (const role of ROLES) {
      const provider = rows.get(role.providerEnv);
      const model = rows.get(role.modelEnv);
      expect(provider?.path).toBe(`${role.path}.provider`);
      expect(model?.path).toBe(`${role.path}.model`);
      expect(provider?.scope).toBe(role.scope);
      expect(model?.provider).toBe(role.providerEnv);
      expect(provider?.default ?? null).toBe(role.follows ? null : role.defaultProvider);
      if (role.follows) {
        const followed = ROLES.find((other) => other.id === role.follows);
        expect(provider?.follows).toBe(followed?.providerEnv);
      }
      expect(model?.legacy).toEqual(role.legacyModelEnv);
      if (role.defaultProvider !== null) {
        expect(providersFor(role.category).map((p) => p.id)).toContain(role.defaultProvider);
      }
    }
  });
});
