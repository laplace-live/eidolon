// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/src/login-shell-environment.ts@2e39e70496
//
// The backend's environment: the one the app was launched with, under the owner's login shell's
// variables on macOS and the registry's on Windows. The controller adds its own variables
// (backendEnv).
import { type LoginShellFailure, PROBE_ENVIRONMENT, readLoginShell } from "./login-shell.ts";
import { ENVIRONMENT_KEYS, type RegistryValue, readRegistry } from "./registry-environment.ts";

/** They describe the probe's own shell process, not the owner's configuration. */
const SESSION = new Set(["PWD", "OLDPWD", "SHLVL", "_", ...Object.keys(PROBE_ENVIRONMENT)]);

/** As @eidolon/config's envFlag reads a flag. */
const FLAG_OFF = new Set(["false", "0", "no", "off"]);
const FLAG_ON = new Set(["true", "1", "yes", "on"]);

/**
 * How long the startup read stands in for the first spawn's: a cold start spawns within a hint
 * probe's 2 s of it, and a server attached at startup gives way to ours only after 60 s.
 */
const STARTUP_READ_MS = 10_000;

export interface EnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  /** The login shells to try; the account's, then zsh, bash and sh, unless a test names its own. */
  readonly shells?: readonly string[];
  /** The powershell.exe that reads the registry: the system's, unless a test names its own. */
  readonly powershell?: string;
  /** Aborting ends a login shell's or the registry's read: the launch environment is used. */
  readonly signal?: AbortSignal;
  /** Where a read's failure goes: main.log. */
  readonly log?: { warn(message: string): void };
}

export interface EnvironmentRead {
  readonly env: NodeJS.ProcessEnv;
  /** The login shells that gave nothing, in the order tried; empty when none was read. */
  readonly failures: readonly LoginShellFailure[];
}

export interface StartupEnvironment {
  /** What the startup read gave, which the data home comes from. */
  readonly env: NodeJS.ProcessEnv;
  /**
   * The controller's `environment`, called before each spawn: a fresh read, so a Restart sees a
   * changed PATH, but for a first spawn just after startup, which takes the startup read so a cold
   * start runs the owner's rc files, or PowerShell, once.
   */
  readonly forSpawn: () => Promise<NodeJS.ProcessEnv>;
}

/** Every key of `env` that names `name`: on Windows, whose names have no case, each spelling. */
function keysOf(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return Object.hasOwn(env, name) ? [name] : [];
  const upper = name.toUpperCase();
  return Object.keys(env).filter((key) => key.toUpperCase() === upper);
}

function read(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const [key] = keysOf(env, name, platform);
  return key === undefined ? undefined : env[key];
}

/**
 * Sets `name` under one key: the spelling `env` already has, else `name`. A copy of Windows'
 * environment, unlike the live `process.env`, has case, and spawn keeps only the first of two
 * spellings in sorted order (`PATH` before `Path`).
 */
function write(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  const [key = name, ...others] = keysOf(env, name, platform);
  for (const other of others) delete env[other];
  env[key] = value;
}

/**
 * A flag in the launch environment, read as @eidolon/config's envFlag reads one: a default-on flag
 * turns off only for false, 0, no or off, a default-off one on only for true, 1, yes or on, in any
 * case and spacing. Blank counts as unset.
 */
export function launchFlag(
  launch: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const raw = read(launch, name, platform)?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return fallback ? !FLAG_OFF.has(raw) : FLAG_ON.has(raw);
}

/**
 * `EIDOLON_DESKTOP_LOGIN_SHELL` turned off in the launch environment, as both smokes turn it: no
 * login shell on macOS, no registry read on Windows.
 */
export function loginShellOff(
  launch: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !launchFlag(launch, "EIDOLON_DESKTOP_LOGIN_SHELL", true, platform);
}

/**
 * Whether a merge leaves `name` as `launch` has it: the probe shell's own variables; `ELECTRON_*`,
 * which never come from outside the app; and an `EIDOLON_*` that `launch` sets, so a smoke's or a
 * terminal's `EIDOLON_HOME` holds. A blank value counts as unset there, as everywhere in Eidolon.
 */
function launchKeeps(launch: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): boolean {
  const folded = platform === "win32" ? name.toUpperCase() : name;
  if (SESSION.has(folded) || folded.startsWith("ELECTRON_")) return true;
  return folded.startsWith("EIDOLON_") && Boolean(read(launch, name, platform));
}

/** `launch` with the login shell's variables over it, but for those `launchKeeps`. */
export function mergeShellEnvironment(
  launch: NodeJS.ProcessEnv,
  shell: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const merged = { ...launch };
  for (const [name, value] of Object.entries(shell)) {
    if (!launchKeeps(launch, name, platform)) write(merged, name, value, platform);
  }
  return merged;
}

/**
 * `value` with each `%NAME%` that `env` has replaced by its value, names matched without case. As
 * Windows expands, an unknown name stays as written, and its closing `%` may open the next one.
 */
function expand(value: string, env: NodeJS.ProcessEnv): string {
  const parts = value.split("%");
  let expanded = parts[0] as string;
  let i = 1;
  while (i < parts.length) {
    const name = parts[i] as string;
    const found = i + 1 < parts.length ? read(env, name, "win32") : undefined;
    if (found === undefined) {
      expanded += `%${name}`;
      i += 1;
    } else {
      expanded += found + parts[i + 1];
      i += 2;
    }
  }
  return expanded;
}

/**
 * Windows: `launch` with the registry's variables over it, as Windows builds a new process's: key
 * by key, its REG_SZ values before its REG_EXPAND_SZ ones, which expand against the variables so
 * far, and no other kind. `Path` is each key's own, the system's first, with a `;` between where
 * the one before doesn't end with one. A name `launchKeeps` stays as `launch` has it, and so does
 * a variable deleted from the registry since.
 */
export function mergeRegistryEnvironment(
  launch: NodeJS.ProcessEnv,
  keys: readonly (readonly RegistryValue[])[],
): NodeJS.ProcessEnv {
  const merged = { ...launch };
  const owner = read(launch, "USERNAME", "win32");
  let path: string | undefined;
  for (const [index, values] of keys.entries()) {
    for (const kind of ["String", "ExpandString"]) {
      for (const { name, kind: stored, value } of values) {
        if (stored !== kind || launchKeeps(launch, name, "win32")) continue;
        let text = kind === "String" ? value : expand(value, merged);
        if (name.toUpperCase() === "PATH") {
          path = !path || path.endsWith(";") ? `${path ?? ""}${text}` : `${path};${text}`;
          text = path;
        }
        write(merged, name, text, "win32");
      }
    }
    // Windows sets the account's USERNAME between the system key, whose own is SYSTEM, and the
    // user's, whose values expand with it.
    if (index === 0 && owner) write(merged, "USERNAME", owner, "win32");
  }
  return merged;
}

/**
 * What the backend runs on before its own variables: `launch` under the login shell's on macOS and
 * the registry's on Windows, unless `EIDOLON_DESKTOP_LOGIN_SHELL` is off or the read fails. Never
 * rejects; a read that fails is logged.
 */
export async function readEnvironment(
  launch: NodeJS.ProcessEnv,
  {
    platform = process.platform,
    shells,
    powershell,
    signal,
    log = console,
  }: EnvironmentOptions = {},
): Promise<EnvironmentRead> {
  if (loginShellOff(launch, platform)) return { env: { ...launch }, failures: [] };
  if (platform === "win32") {
    const registry = await readRegistry(ENVIRONMENT_KEYS, { env: launch, powershell, signal });
    if ("values" in registry) {
      return { env: mergeRegistryEnvironment(launch, registry.values), failures: [] };
    }
    log.warn(
      `Eidolon: couldn't read the registry's variables, so the backend runs on the launch's: ${registry.failure}`,
    );
    return { env: { ...launch }, failures: [] };
  }
  const { variables, failures } = await readLoginShell(launch, { shells, signal });
  if (failures.length > 0) {
    const failed = failures.map(({ shell, reason }) => `${shell} (${reason})`).join(", ");
    log.warn(
      variables === null
        ? `Eidolon: no login shell gave its environment, so the backend runs on the launch's: ${failed}`
        : `Eidolon: login shells that gave no environment before one did: ${failed}`,
    );
  }
  const env =
    variables === null ? { ...launch } : mergeShellEnvironment(launch, variables, platform);
  return { env, failures };
}

/** Reads the environment at startup, for the data home, and serves each spawn's after it. */
export async function startupEnvironment(
  launch: NodeJS.ProcessEnv,
  options: EnvironmentOptions = {},
): Promise<StartupEnvironment> {
  const { env } = await readEnvironment(launch, options);
  const readAt = Date.now();
  let unused: NodeJS.ProcessEnv | null = env;
  return {
    env,
    forSpawn: async () => {
      const startup = unused !== null && Date.now() - readAt <= STARTUP_READ_MS ? unused : null;
      unused = null;
      return startup ?? (await readEnvironment(launch, options)).env;
    },
  };
}
