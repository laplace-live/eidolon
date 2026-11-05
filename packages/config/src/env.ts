// dotenv parses `KEY=` as "", so a plain .env.example copy sets every key to the empty string.
// Every reader here treats empty as unset.
import { logger } from "./logger.ts";
import { pyParseFloat, pyParseInt, pyRepr } from "./py.ts";

// What settings.yaml, persona.yaml and credentials.json set, keyed by the variable each setting
// maps to. A non-empty environment variable always wins, so a deployment's env stays authoritative.
let fileLayer: ReadonlyMap<string, string> = new Map();

/** Replaces the values the settings files supply; settings.ts is the only caller. */
export function setFileLayer(values: ReadonlyMap<string, string>): void {
  fileLayer = values;
}

/**
 * Exactly `os.getenv(name)`, `""` included, unless a settings file supplies the value. Only for
 * variables where blank means something.
 */
export function envRaw(name: string): string | undefined {
  const raw = process.env[name];
  return raw ? raw : (fileLayer.get(name) ?? raw);
}

/** A non-empty environment variable: the one value that wins over every settings file. */
export function envOverride(name: string): string | undefined {
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
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(process.env)) {
    const resolved = envRaw(key);
    if (value !== undefined && resolved !== undefined) entries.push([key, resolved]);
  }
  for (const [key, value] of fileLayer) {
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

/** `env_int`: Python `int()` of the value, or `fallback` (with a warning) where it raises. */
export function envInt(name: string, fallback: number): number {
  const raw = envOptional(name);
  if (raw === undefined) return fallback;
  const value = pyParseInt(raw);
  if (value !== null) return value;
  logger.warning(`${name}=${pyRepr(raw)} is not a valid int; using default ${fallback}`);
  return fallback;
}

/** `env_float`: Python `float()` of the value, or `fallback` (with a warning) where it raises. */
export function envFloat(name: string, fallback: number): number {
  const raw = envOptional(name);
  if (raw === undefined) return fallback;
  const value = pyParseFloat(raw);
  if (value !== null) return value;
  logger.warning(`${name}=${pyRepr(raw)} is not a valid float; using default ${fallback}`);
  return fallback;
}
