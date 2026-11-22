// The environment a desktop smoke starts the app with: the OS's own variables from the smoke's and
// nothing else of it, then the fakes' accounts, the run's homes and the app's test switches. A key
// or setting the developer's shell exports would otherwise reach the backend, win over the fakes'
// accounts (a non-empty variable beats credentials.json) and bill.
import { CREDENTIALS, SETTINGS } from "@eidolon/config";
import { PROVIDERS } from "../../../../packages/providers/src/catalog.ts";

/** The variables a login gives every process, which Electron, the backend and its tools read. */
export const OS_NAMES: { readonly posix: readonly string[]; readonly win32: readonly string[] } = {
  posix: ["HOME", "USER", "TMPDIR", "PATH", "LANG"],
  // Node, Electron, the NSIS setup and Git for Windows read these; an Explorer launch has them all.
  win32: [
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ALLUSERSPROFILE",
    "PUBLIC",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "CommonProgramFiles(x86)",
    "CommonProgramW6432",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
  ],
};

/**
 * What apps/bot/scripts/local-smoke.ts's childEnv drops: every credential, every setting's variable,
 * and every provider's base URL and field.
 */
export const DROPPED_NAMES: ReadonlySet<string> = new Set([
  ...CREDENTIALS,
  ...SETTINGS.map((row) => row.env),
  ...PROVIDERS.flatMap((provider) => [
    ...(provider.baseUrlEnv === null ? [] : [provider.baseUrlEnv]),
    ...(provider.fields ?? []).map((field) => field.env),
  ]),
]);

/** Never passed on from the smoke's environment: a dropped name, any EIDOLON_* or ELECTRON_*. */
export function isDropped(name: string): boolean {
  const upper = name.toUpperCase();
  return DROPPED_NAMES.has(upper) || upper.startsWith("EIDOLON_") || upper.startsWith("ELECTRON_");
}

/** The OS's own variables in `from`, under the spelling it has; on Windows found without case. */
export function osVariables(
  from: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const windows = platform === "win32";
  const wanted = new Set(
    (windows ? OS_NAMES.win32 : OS_NAMES.posix).map((name) =>
      windows ? name.toUpperCase() : name,
    ),
  );
  const picked: Record<string, string> = {};
  const taken = new Set<string>();
  for (const [name, value] of Object.entries(from)) {
    const key = windows ? name.toUpperCase() : name;
    // A copy of Windows' environment can spell one name twice; spawn would keep either.
    if (value === undefined || !wanted.has(key) || taken.has(key) || isDropped(name)) continue;
    taken.add(key);
    picked[name] = value;
  }
  return picked;
}

/** Where the fakes listen, and the one key they take. */
export interface FakeAccount {
  /** Their API base, `http://127.0.0.1:<port>/v1`. */
  readonly url: string;
  readonly key: string;
}

/**
 * Every role a smoke reaches, on the fakes: OpenRouter's account (her mind, embeddings, the selfie's
 * images, the gate's and the director's decisions, tasks) and OpenAI's, which hears and speaks
 * because Soniox and Fish, the defaults, take no base URL.
 */
export function fakeAccounts({ url, key }: FakeAccount): Record<string, string> {
  return {
    OPENROUTER_API_KEY: key,
    OPENROUTER_API_BASE: url,
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: url,
    STT_PROVIDER: "openai",
    TTS_PROVIDER: "openai",
    TTS_VOICE_ID: "marin",
  };
}

/** A run's folders as the app reads them. */
export interface Homes {
  /** EIDOLON_HOME. */
  readonly home: string;
  /** EIDOLON_REAL_HOME, which only the real-data tests read: never the owner's. */
  readonly realHome: string;
  /** EIDOLON_SHARED_SKILLS: never the owner's shared skills. */
  readonly sharedSkills: string;
}

export interface AppEnvOptions {
  readonly homes: Homes;
  readonly fakes: FakeAccount;
  /** EIDOLON_DESKTOP_BACKGROUND, off only for --headful. */
  readonly background: boolean;
  /** The smoke's own environment, which only the OS's variables come from. */
  readonly from?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/**
 * The app's environment: the OS's variables, the fakes' accounts, the homes, no .env, no login
 * shell read, and background mode unless the smoke is headful. A server started on the same home,
 * for the app to attach to, takes it too.
 */
export function appEnv({
  homes,
  fakes,
  background,
  from = process.env,
  platform = process.platform,
}: AppEnvOptions): Record<string, string> {
  return {
    ...osVariables(from, platform),
    ...fakeAccounts(fakes),
    EIDOLON_HOME: homes.home,
    EIDOLON_REAL_HOME: homes.realHome,
    EIDOLON_SHARED_SKILLS: homes.sharedSkills,
    EIDOLON_NO_DOTENV: "1",
    EIDOLON_DESKTOP_LOGIN_SHELL: "0",
    ...(background ? { EIDOLON_DESKTOP_BACKGROUND: "1" } : {}),
  };
}
