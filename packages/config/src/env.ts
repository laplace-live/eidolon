// dotenv parses `KEY=` as "", so a plain .env.example copy sets every key to the empty string.
// Every reader here treats empty as unset.
import { logger } from "./logger.ts";
import { pyParseFloat, pyParseInt, pyRepr } from "./py.ts";

/** Exactly `os.getenv(name)`: `""` stays `""`. Only for variables where blank means something. */
export function envRaw(name: string): string | undefined {
  return process.env[name];
}

/** The value, or `undefined` when the variable is unset or empty. */
export function envOptional(name: string): string | undefined {
  const raw = process.env[name];
  return raw ? raw : undefined;
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
