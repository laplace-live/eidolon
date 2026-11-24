// Windows: the variables the registry holds for a new process, which the launch environment lacks
// once an installer has changed them. Electron-free: environment.ts merges them over it.
import { type ExecFileException, execFile } from "node:child_process";
import { powershellArgs, powershellExe } from "./update-signature.ts";

/** How long PowerShell may take before the launch environment stands. */
const TIMEOUT_MS = 10_000;

/** The keys Windows builds a new process's environment from, in its order. */
export const ENVIRONMENT_KEYS: readonly string[] = [
  "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "HKCU:\\Environment",
  // The owner's name and folders, as the session set them at sign-in.
  "HKCU:\\Volatile Environment",
];

/** One value of a key, as stored. */
export interface RegistryValue {
  readonly name: string;
  /** Its RegistryValueKind: `String` (REG_SZ), `ExpandString` (REG_EXPAND_SZ), `DWord`, … */
  readonly kind: string;
  /** An ExpandString's `%NAME%`s unexpanded. */
  readonly value: string;
}

/**
 * Each key's values, in the order the keys were given, or why there are none: `exit <code>` with
 * the first line PowerShell printed on stderr, `timeout`, `aborted`, a spawn error, or `unparsed`.
 */
export type RegistryRead =
  | { readonly values: readonly (readonly RegistryValue[])[] }
  | { readonly failure: string };

export interface RegistryOptions {
  /** The environment PowerShell runs on. */
  readonly env?: NodeJS.ProcessEnv;
  /** The powershell.exe to run: the system's, under `env`'s SystemRoot, unless a test's. */
  readonly powershell?: string;
  readonly timeoutMs?: number;
  /** Aborting kills PowerShell. */
  readonly signal?: AbortSignal;
}

/**
 * The PowerShell script that prints every value of `keys`, provider paths taken as literals, as
 * JSON: unexpanded, with its kind and its key's index. On any error it prints why on stderr and
 * exits 1, having printed nothing else.
 */
export function registryScript(keys: readonly string[]): string {
  const literals = keys.map((key) => `'${key.replace(/'/g, "''")}'`).join(", ");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    "  [Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `  $keys = @(${literals})`,
    "  $values = @(for ($i = 0; $i -lt $keys.Count; $i++) {",
    "    $key = Get-Item -LiteralPath $keys[$i]",
    "    foreach ($name in $key.GetValueNames()) {",
    "      [pscustomobject]@{",
    "        Key = $i",
    "        Name = $name",
    "        Kind = [string]$key.GetValueKind($name)",
    "        Value = [string]$key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')",
    "      }",
    "    }",
    "  })",
    "  ConvertTo-Json -InputObject $values -Compress",
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
}

/** The values of each of `keys` keys from the script's output; undefined for any other output. */
export function parseRegistryOutput(stdout: string, keys: number): RegistryValue[][] | undefined {
  let records: unknown;
  try {
    records = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!Array.isArray(records)) return undefined;
  const values: RegistryValue[][] = Array.from({ length: keys }, () => []);
  for (const record of records) {
    const { Key, Name, Kind, Value } = (record ?? {}) as Record<string, unknown>;
    const key = typeof Key === "number" ? values[Key] : undefined;
    if (key === undefined || typeof Name !== "string" || typeof Kind !== "string") return undefined;
    if (typeof Value !== "string") return undefined;
    // A value written with an extra terminator keeps a NUL in .NET, which spawn refuses in an
    // environment; Windows reads it only up to there.
    key.push({ name: Name, kind: Kind, value: Value.split("\0", 1)[0] as string });
  }
  return values;
}

function failureOf(error: ExecFileException, stderr: string): string {
  if (error.name === "AbortError") return "aborted";
  if (typeof error.code === "number") {
    const said = stderr.trim().split(/\r?\n/, 1)[0] ?? "";
    return said === "" ? `exit ${error.code}` : `exit ${error.code}: ${said.slice(0, 200)}`;
  }
  if (typeof error.code === "string") return error.message;
  return error.killed ? "timeout" : (error.signal ?? error.message);
}

/**
 * Reads `keys` with one powershell.exe run; never rejects. Not reg.exe, whose redirected output
 * follows the OEM code page and garbles a path that isn't ASCII.
 */
export function readRegistry(
  keys: readonly string[],
  {
    env = process.env,
    powershell = powershellExe(env),
    timeoutMs = TIMEOUT_MS,
    signal,
  }: RegistryOptions = {},
): Promise<RegistryRead> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ failure: "aborted" });
      return;
    }
    // As updater.ts does (electron-builder#7127): PowerShell 7's module path breaks 5.1's.
    const childEnv = { ...env };
    for (const name of Object.keys(childEnv)) {
      if (/^psmodulepath$/i.test(name)) delete childEnv[name];
    }
    try {
      execFile(
        powershell,
        powershellArgs(registryScript(keys)),
        { encoding: "utf8", env: childEnv, timeout: timeoutMs, windowsHide: true, signal },
        (error, stdout, stderr) => {
          if (error !== null) {
            resolve({ failure: failureOf(error, stderr) });
            return;
          }
          const values = parseRegistryOutput(stdout, keys.length);
          resolve(values === undefined ? { failure: "unparsed" } : { values });
        },
      );
    } catch (error) {
      resolve({ failure: String(error) });
    }
  });
}
