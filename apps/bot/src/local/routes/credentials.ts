// /api/local/credentials: which keys are set (never their values), saving them into
// credentials.json (mode 0600 from its first byte), and checking one against its provider.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CREDENTIALS,
  dataHome,
  envOptional,
  envOverride,
  isPlainObject,
  logger,
} from "@eidolon/config";
import { CHECK_PROVIDERS, type CheckProvider, type CredentialsResponse } from "../api.ts";
import { type CheckDeps, checkProvider } from "../checks.ts";
import { localError, localJson, readJson } from "../responses.ts";
import { reinstallSettings } from "../restart.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";
import { fishVoiceKey, recordQdrant, recordVoice } from "../status.ts";
import { writeDataFile } from "../write.ts";

/** A key's longest plausible length; anything longer is a paste gone wrong. */
const MAX_KEY_CHARS = 4096;
const CONTROL = /\p{Cc}/u;

export function credentialsPath(): string {
  return join(dataHome(), "credentials.json");
}

/** credentials.json's object, `{}` when there is none, or null when it doesn't parse as one. */
export function savedCredentials(): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(credentialsPath(), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function credentialStates(): CredentialsResponse {
  const saved = savedCredentials() ?? {};
  const states: Record<string, CredentialsResponse[string]> = {};
  for (const name of CREDENTIALS) {
    const fromEnv = envOverride(name) !== undefined;
    const fromFile = typeof saved[name] === "string" && saved[name] !== "";
    states[name] = {
      set: fromEnv || fromFile,
      source: fromEnv ? "env" : fromFile ? "credentials" : null,
    };
  }
  return states;
}

/** credentials.json to write into, or the 409 refusing to write over a file that doesn't parse. */
export function writableCredentials(): Record<string, unknown> | Response {
  const saved = savedCredentials();
  if (saved !== null) return saved;
  logger.warning(`${credentialsPath()} is not valid JSON; saving keys waits until it is`);
  return localError(
    409,
    "conflict",
    "credentials.json isn't valid JSON; fix or delete it, then save again",
  );
}

/** A key or address as typed: one line, trimmed; null for anything else. */
export function typedValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_KEY_CHARS) return null;
  const trimmed = value.trim();
  return trimmed === "" || CONTROL.test(trimmed) ? null : trimmed;
}

/** Writes credentials.json, mode 0600: known keys in their usual order, then the rest untouched. */
export function writeCredentials(saved: Readonly<Record<string, unknown>>): void {
  const ordered: Record<string, unknown> = {};
  for (const name of CREDENTIALS) {
    if (name in saved) ordered[name] = saved[name];
  }
  for (const [name, value] of Object.entries(saved)) {
    if (!(name in ordered)) ordered[name] = value;
  }
  writeDataFile(credentialsPath(), `${JSON.stringify(ordered, null, 2)}\n`, { secret: true });
}

export interface CredentialsDeps {
  readonly check: Pick<CheckDeps, "fetch" | "now">;
}

const defaultDeps: CredentialsDeps = { check: { fetch, now: Date.now } };

export function credentialsRoutes(
  app: LocalApp,
  deps: CredentialsDeps = defaultDeps,
): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/credentials",
      handler: () => localJson(200, credentialStates()),
    },
    {
      route: "PUT /api/local/credentials",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        if (!isPlainObject(body.value)) {
          return localError(400, "bad-request", "Send {NAME: key or null}");
        }
        const updates: [string, string | null][] = [];
        for (const [name, value] of Object.entries(body.value)) {
          // Neither the name nor the value goes back: a key pasted into the wrong field is a key.
          if (!CREDENTIALS.includes(name)) {
            return localError(400, "unknown-credential", "A name is not a key Eidolon uses");
          }
          const key = value === null ? null : typedValue(value);
          if (value !== null && key === null) {
            return localError(400, "bad-request", "A key is one line of text; null removes it");
          }
          updates.push([name, key]);
        }
        const saved = writableCredentials();
        if (saved instanceof Response) return saved;
        for (const [name, key] of updates) {
          if (key === null) delete saved[name];
          else saved[name] = key;
        }
        writeCredentials(saved);
        reinstallSettings(app);
        return localJson(200, credentialStates());
      },
    },
    {
      route: "POST /api/local/credentials/check",
      async handler(request) {
        const body = await readJson(request);
        if (!body.ok) return body.response;
        const value = isPlainObject(body.value) ? body.value : {};
        const provider = value.provider;
        if (
          typeof provider !== "string" ||
          !(CHECK_PROVIDERS as readonly string[]).includes(provider)
        ) {
          return localError(400, "bad-request", "Name a provider to check");
        }
        const typed = value.value === undefined ? undefined : typedValue(value.value);
        if (typed === null) {
          return localError(400, "bad-request", "The value to check is one line of text");
        }
        // The key a check of the saved one reads, which its answer about the voice is for.
        const fishKey = fishVoiceKey();
        const outcome = await checkProvider(provider as CheckProvider, typed, {
          ...deps.check,
          read: envOptional,
          fromEnv: (name) => envOverride(name) !== undefined,
        });
        // What the check learned of the saved voice and Qdrant, GET status shows too.
        if (outcome.voice !== undefined && typed === undefined && fishKey !== undefined) {
          recordVoice(app, outcome.voice.id, fishKey, outcome.voice.ok);
        }
        if (outcome.qdrant !== undefined && typed === undefined) {
          recordQdrant(app, outcome.qdrant, outcome.qdrant.ok);
        }
        return localJson(200, outcome.result);
      },
    },
  ];
}
