// dotenv parses `KEY=` as "", so a plain .env.example copy sets every key to the empty string.
// Every reader here treats empty as unset.
import { logger } from "./logger.ts";
import { pyParseFloat, pyParseInt, pyRepr } from "./py.ts";
import { type FileLayer, personaScopes } from "./scope.ts";

// What settings.yaml, persona.yaml and credentials.json set, keyed by the variable each setting
// maps to. A non-empty environment variable wins over the files, so a deployment's env stays
// authoritative, except for a variable the persona's own file decides: there the environment is
// ignored, and with no value in her file the variable is unset.
let installed: FileLayer = { values: new Map(), owned: new Set() };

/**
 * Replaces the values the settings files supply, and the variables the persona's file decides;
 * settings.ts is the only caller.
 */
export function setFileLayer(
  values: ReadonlyMap<string, string>,
  ownedNames: ReadonlySet<string>,
): void {
  installed = { values, owned: ownedNames };
}

function currentLayer(): FileLayer {
  return personaScopes.getStore() ?? installed;
}

function fromEnvironment(layer: FileLayer, name: string): string | undefined {
  return layer.owned.has(name) ? undefined : process.env[name];
}

function rawIn(layer: FileLayer, name: string): string | undefined {
  const raw = fromEnvironment(layer, name);
  return raw ? raw : (layer.values.get(name) ?? raw);
}

/**
 * Exactly `os.getenv(name)`, `""` included, unless a settings file supplies the value. Only for
 * variables where blank means something.
 */
export function envRaw(name: string): string | undefined {
  return rawIn(currentLayer(), name);
}

/** A non-empty environment variable that wins over the files: never one the persona's decides. */
export function envOverride(name: string): string | undefined {
  const raw = fromEnvironment(currentLayer(), name);
  return raw ? raw : undefined;
}

/** The environment's own non-empty value, even where a persona's file decides the variable. */
export function envVariable(name: string): string | undefined {
  const raw = process.env[name];
  return raw ? raw : undefined;
}

/** The value, or `undefined` when the variable is unset or empty. */
export function envOptional(name: string): string | undefined {
  const raw = envRaw(name);
  return raw ? raw : undefined;
}

/** Every variable that has a value, environment order first, then names only the files set. */
export function envEntries(): [string, string][] {
  const layer = currentLayer();
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(process.env)) {
    const resolved = rawIn(layer, key);
    if (value !== undefined && resolved !== undefined) entries.push([key, resolved]);
  }
  for (const [key, value] of layer.values) {
    if (!(key in process.env)) entries.push([key, value]);
  }
  return entries;
}

const FLAG_OFF = new Set(["false", "0", "no", "off"]);
const FLAG_ON = new Set(["true", "1", "yes", "on"]);

/**
 * A default-on flag turns off only for false/0/no/off; a default-off flag turns on only for
 * true/1/yes/on. Case and surrounding whitespace are ignored.
 */
export function envFlag(name: string, fallback: boolean): boolean {
  const raw = envOptional(name)?.trim().toLowerCase();
  if (raw === undefined) return fallback;
  return fallback ? !FLAG_OFF.has(raw) : FLAG_ON.has(raw);
}

export function envStr(name: string, fallback: string): string {
  return envOptional(name) ?? fallback;
}

/** Python `int()` of the value, or `fallback` (with a warning) where it raises. */
export function envInt(name: string, fallback: number): number {
  const raw = envOptional(name);
  if (raw === undefined) return fallback;
  const value = pyParseInt(raw);
  if (value !== null) return value;
  logger.warning(`${name}=${pyRepr(raw)} is not a valid int; using default ${fallback}`);
  return fallback;
}

/** Python `float()` of the value, or `fallback` (with a warning) where it raises. */
export function envFloat(name: string, fallback: number): number {
  const raw = envOptional(name);
  if (raw === undefined) return fallback;
  const value = pyParseFloat(raw);
  if (value !== null) return value;
  logger.warning(`${name}=${pyRepr(raw)} is not a valid float; using default ${fallback}`);
  return fallback;
}
