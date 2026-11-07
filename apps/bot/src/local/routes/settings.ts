// GET and PUT /api/local/settings: every SETTINGS row, layer by layer, and writes into
// settings.yaml or a persona's own persona.yaml. A persona path setting must stay inside her
// folder, and sources.ytDlp is never written here: either would let a page read files or run a
// binary.
import {
  activePersona,
  envOverride,
  envVariable,
  isPlainObject,
  isValidTimeZone,
  pyStrip,
  readSettingsLayers,
  SETTINGS,
  type SettingField,
} from "@eidolon/config";
import type { SettingRow, SettingsResponse } from "../api.ts";
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

export function settingsOf(app: LocalApp, persona: string): SettingsResponse {
  const layers = readSettingsLayers(persona);
  const settings = SETTINGS.map((field): SettingRow => {
    const layer = layers.values.get(field.env);
    // Not envOverride: that answers for the installed persona, and this may be another one.
    const fromEnv = envVariable(field.env) ?? null;
    const productionOnly = PRODUCTION_ONLY.test(field.path);
    return {
      path: field.path,
      env: field.env,
      scope: field.scope,
      kind: field.kind,
      title: field.title,
      value: layer?.raw ?? null,
      source: (layer?.source ?? "default") as SettingRow["source"],
      // A production-only row is hidden, so its value has no reader.
      envValue: productionOnly ? null : fromEnv,
      envOverride: field.scope === "app" && fromEnv !== null,
      productionOnly,
      readOnly: READ_ONLY.has(field.path),
    };
  });
  return {
    persona: layers.persona,
    settings,
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

        const edit = (tree: Record<string, unknown>) => {
          for (const [field, value] of changes) setDotted(tree, field.path, value);
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
