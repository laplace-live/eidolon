// GET and PUT /api/local/settings: every SETTINGS row, layer by layer, and writes into
// settings.yaml or a persona's own persona.yaml. A persona path setting must stay inside her
// folder, and sources.ytDlp is never written here: either would let a page read files or run a
// binary.
import {
  accountProvider,
  activePersona,
  envOverride,
  envVariable,
  envVariablesStartingWith,
  isPlainObject,
  isValidTimeZone,
  layeredValue,
  pyStrip,
  readSettingsLayers,
  SETTINGS,
  type SettingField,
  type SettingsLayers,
} from "@eidolon/config";
import {
  accountOf,
  LEGACY_VOICE_STYLE_PREFIX,
  ROLES,
  roleById,
  VOICE_ENV,
  VOICE_STYLE_PREFIX,
} from "@eidolon/providers";
import { DEFAULT_STYLE, STYLE_HINTS } from "@eidolon/tools";
import type { EnvironmentVoiceStyle, SettingRow, SettingsResponse, VoiceStyles } from "../api.ts";
import {
  editPersonaYaml,
  editSettingsYaml,
  personaRefusal,
  queryPersona,
  setDotted,
  staysInPersona,
  writeFailure,
} from "../personas.ts";
import { localError, localJson, readJson } from "../responses.ts";
import { reinstallSettings, restartTracker } from "../restart.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";

/** Rows only a public deployment reads, which the local app hides. */
const PRODUCTION_ONLY = /^(?:access\.|mcp\.|network\.|audio\.opus|providers\.openrouter\.app)/;
/** Rows shown but never written through the API. */
const READ_ONLY = new Set(["sources.ytDlp"]);
const CONTROL = /\p{Cc}/u;

/**
 * The environment's value for `field`, and which variable holds it: its own, or the provider-named
 * one that set it before, while that provider fills the role. Not envOverride: that answers for the
 * installed persona, and this may be another one.
 */
function environmentValue(
  field: SettingField,
  layers: SettingsLayers,
): { value: string; name: string } | null {
  const own = envVariable(field.env);
  if (own !== undefined) return { value: own, name: field.env };
  const legacy = field.legacy;
  if (legacy === undefined || field.provider === undefined) return null;
  const provider = layeredValue(layers, field.provider) ?? PROVIDER_DEFAULTS.get(field.provider);
  // An account stands for its provider, as the bot reads it.
  const id = provider?.trim().toLowerCase();
  if (id === undefined || accountProvider(id, layers.accounts) !== legacy.provider) return null;
  const value = envVariable(legacy.env);
  return value === undefined ? null : { value, name: legacy.env };
}

/** Each provider row's default, for a row that names none. */
const PROVIDER_DEFAULTS = new Map(
  SETTINGS.filter((field) => field.default !== undefined).map((field) => [
    field.env,
    field.default as string,
  ]),
);

const VOICE_PROVIDER = roleById("voice").providerEnv;

/** The provider her voice would use were her file's voice.provider `own`. */
function voiceProvider(own: string | null, layers: SettingsLayers): string | undefined {
  const id = (own ?? envVariable(VOICE_PROVIDER) ?? PROVIDER_DEFAULTS.get(VOICE_PROVIDER))
    ?.trim()
    .toLowerCase();
  return id ? accountProvider(id, layers.accounts) : undefined;
}

/** The provider her voice uses, with her file's voice.provider as it is. */
function herVoiceProvider(layers: SettingsLayers): string | undefined {
  const saved = layers.values.get(VOICE_PROVIDER);
  return voiceProvider(saved?.source === "persona" ? (saved.value ?? null) : null, layers);
}

/** Whether `changes` move her voice to another provider, whose voice ids her styles aren't. */
function dropsVoiceStyles(changes: readonly [SettingField, unknown][], persona: string): boolean {
  const change = changes.find(([field]) => field.env === VOICE_PROVIDER);
  if (change === undefined) return false;
  const layers = readSettingsLayers(persona);
  return herVoiceProvider(layers) !== voiceProvider(change[1] as string | null, layers);
}

/** Her styles, and each one the environment sets for her voice's provider. */
function voiceStylesOf(layers: SettingsLayers): VoiceStyles {
  const hers = new Set(layers.voiceStyles.map((style) => style.name));
  // Owned when she has her own voice, or a provider other than the environment's.
  const ownVoice = layers.owned.has(VOICE_ENV);
  // Fish's names first, so the neutral name wins where both set a style.
  const prefixes =
    herVoiceProvider(layers) === "fish"
      ? [LEGACY_VOICE_STYLE_PREFIX, VOICE_STYLE_PREFIX]
      : [VOICE_STYLE_PREFIX];
  const environment = new Map<string, EnvironmentVoiceStyle>();
  for (const prefix of prefixes) {
    for (const [env, value] of envVariablesStartingWith(prefix)) {
      const voiceId = pyStrip(value);
      const name = env.slice(prefix.length).toLowerCase();
      if (!voiceId || !name || name === DEFAULT_STYLE) continue;
      const state = ownVoice ? "ignored" : hers.has(name) ? "replaced" : "inherited";
      environment.set(name, { name, voiceId, env, state });
    }
  }
  return {
    own: layers.voiceStyles,
    environment: [...environment.values()].sort((a, b) => a.name.localeCompare(b.name)),
    builtInHints: STYLE_HINTS,
  };
}

export function settingsOf(app: LocalApp, persona: string): SettingsResponse {
  const layers = readSettingsLayers(persona);
  const settings = SETTINGS.map((field): SettingRow => {
    const layer = layers.values.get(field.env);
    const productionOnly = PRODUCTION_ONLY.test(field.path);
    // Hers decides a row whose environment value belongs to a provider she doesn't use.
    const ignored = layers.owned.has(field.env) && (layer?.value ?? null) === null;
    const fromEnv = ignored ? null : environmentValue(field, layers);
    // A production-only row is hidden, so its value has no reader.
    const shown = productionOnly ? null : fromEnv;
    return {
      path: field.path,
      env: field.env,
      scope: field.scope,
      kind: field.kind,
      title: field.title,
      value: layer?.raw ?? null,
      source: (layer?.source ?? "default") as SettingRow["source"],
      envValue: shown?.value ?? null,
      envName: shown?.name ?? null,
      envOverride: field.scope === "app" && fromEnv !== null,
      productionOnly,
      readOnly: READ_ONLY.has(field.path),
    };
  });
  return {
    persona: layers.persona,
    settings,
    voiceStyles: voiceStylesOf(layers),
    // A credentials.json that fails to parse has its parser's message, which can quote a key.
    warnings: layers.warnings.filter((warning) => !warning.includes(layers.files.credentials)),
    restartRequired: restartTracker(app).changes().calls.length > 0,
  };
}

type Checked =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; response: Response };

const invalid = (message: string): Checked => ({
  ok: false,
  response: localError(400, "invalid-setting", message),
});

/** One line of text, stripped; "" and null both remove the key. */
function text(value: unknown): Checked {
  if (typeof value !== "string" || CONTROL.test(value)) {
    return invalid("A text setting is one line of text");
  }
  const stripped = pyStrip(value);
  return { ok: true, value: stripped === "" ? null : stripped };
}

/** Items the bot joins with "," and splits again, so none may hold one. */
function items(value: unknown): string[] | null {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || item.includes(",") || CONTROL.test(item)) return null;
    const stripped = pyStrip(item);
    if (stripped !== "") out.push(stripped);
  }
  return out;
}

/** `value` checked as `field`'s kind; a persona's paths must stay inside her folder. */
export function checkValue(field: SettingField, value: unknown, persona: string): Checked {
  if (READ_ONLY.has(field.path)) {
    return {
      ok: false,
      response: localError(400, "read-only-setting", "Set the yt-dlp path in settings.yaml"),
    };
  }
  if (value === null) return { ok: true, value: null };
  switch (field.kind) {
    case "string": {
      const checked = text(value);
      if (!checked.ok || checked.value === null) return checked;
      if (field.env === "PERSONA_TIMEZONE" && !isValidTimeZone(checked.value as string)) {
        return invalid("The time zone is not an IANA zone name");
      }
      const role = ROLES.find((entry) => entry.providerEnv === field.env);
      if (role !== undefined) {
        // A provider's id names its default account; any other, an account credentials.json holds.
        const account = accountOf((checked.value as string).toLowerCase());
        if (account?.provider.offers[role.category] === undefined) {
          return invalid(`Not an account Eidolon knows for ${role.label}`);
        }
        return { ok: true, value: account.id };
      }
      if (field.env !== "EIDOLON_PERSONA") return checked;
      const refused = personaRefusal(checked.value as string);
      return refused === null ? checked : { ok: false, response: refused };
    }
    case "int":
      return Number.isSafeInteger(value) ? { ok: true, value } : invalid("Expected a whole number");
    case "float":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true, value }
        : invalid("Expected a number");
    case "flag":
      return typeof value === "boolean" ? { ok: true, value } : invalid("Expected true or false");
    case "list": {
      const list = items(value);
      if (list === null) return invalid("Expected a list of text without commas");
      return { ok: true, value: list.length > 0 ? list : null };
    }
    case "path": {
      const checked = text(value);
      if (!checked.ok || checked.value === null || field.scope !== "persona") return checked;
      return staysInPersona(persona, checked.value as string)
        ? checked
        : {
            ok: false,
            response: localError(400, "invalid-path", "A persona's path stays inside her folder"),
          };
    }
    case "paths": {
      const list = items(value);
      if (list === null) return invalid("Expected a list of paths without commas");
      if (field.scope === "persona") {
        for (const path of list) {
          if (!/^https?:\/\//.test(path) && !staysInPersona(persona, path)) {
            return {
              ok: false,
              response: localError(400, "invalid-path", "A persona's path stays inside her folder"),
            };
          }
        }
      }
      return { ok: true, value: list.length > 0 ? list : null };
    }
  }
}

/** Why the active persona can't change now, or null. */
export function switchRefusal(app: LocalApp): Response | null {
  if (app.activeCalls() > 0) {
    return localError(409, "call-active", "Switching personas waits until the call ends");
  }
  if (envOverride("EIDOLON_PERSONA") !== undefined) {
    return localError(409, "conflict", "EIDOLON_PERSONA in the environment picks the persona");
  }
  return null;
}

export function settingsRoutes(app: LocalApp): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/settings",
      handler(_request, { url }) {
        const persona = queryPersona(url);
        return persona instanceof Response ? persona : localJson(200, settingsOf(app, persona));
      },
    },
    {
      route: "PUT /api/local/settings",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const update = body.value;
        if (
          !isPlainObject(update) ||
          (update.scope !== "app" && update.scope !== "persona") ||
          !isPlainObject(update.values)
        ) {
          return localError(400, "bad-request", "Send {scope, persona?, values}");
        }
        const scope = update.scope;
        let persona = activePersona().id;
        if (scope === "persona") {
          if (typeof update.persona !== "string") {
            return localError(400, "bad-request", "A persona setting names its persona");
          }
          const refused = personaRefusal(update.persona);
          if (refused !== null) return refused;
          persona = update.persona;
        }

        const changes: [SettingField, unknown][] = [];
        for (const [path, value] of Object.entries(update.values)) {
          const field = SETTINGS.find((row) => row.path === path && row.scope === scope);
          if (field === undefined) {
            return localError(400, "unknown-setting", "A value names no setting of this scope");
          }
          const checked = checkValue(field, value, persona);
          if (!checked.ok) return checked.response;
          changes.push([field, checked.value]);
        }
        if (changes.some(([field]) => field.env === "EIDOLON_PERSONA")) {
          const refused = switchRefusal(app);
          if (refused !== null) return refused;
        }
        // Nothing to write: a persona's first write would copy her template for no change.
        if (changes.length === 0) return localJson(200, settingsOf(app, persona));

        const dropStyles = scope === "persona" && dropsVoiceStyles(changes, persona);
        const edit = (tree: Record<string, unknown>) => {
          for (const [field, value] of changes) setDotted(tree, field.path, value);
          if (dropStyles) setDotted(tree, "voice.styles", null);
        };
        try {
          if (scope === "app") editSettingsYaml(edit);
          else editPersonaYaml(persona, edit);
        } catch (error) {
          return writeFailure(error);
        }
        reinstallSettings(app);
        return localJson(200, settingsOf(app, scope === "app" ? activePersona().id : persona));
      },
    },
  ];
}
