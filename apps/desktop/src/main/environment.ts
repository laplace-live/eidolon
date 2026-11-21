// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/src/login-shell-environment.ts@2e39e70496
//
// The backend's environment: on macOS the owner's login shell's over the one the app was launched
// with, on Windows the launch environment as it is. The controller adds its own variables
// (backendEnv).
import { type LoginShellFailure, PROBE_ENVIRONMENT, readLoginShell } from "./login-shell.ts";

/** They describe the probe's own shell process, not the owner's configuration. */
const SESSION = new Set(["PWD", "OLDPWD", "SHLVL", "_", ...Object.keys(PROBE_ENVIRONMENT)]);

/** As @eidolon/config's envFlag reads a flag that defaults to on. */
const FLAG_OFF = new Set(["false", "0", "no", "off"]);

/**
 * How long the startup read stands in for the first spawn's: a cold start spawns within a hint
 * probe's 2 s of it, and a server attached at startup gives way to ours only after 60 s.
 */
const STARTUP_READ_MS = 10_000;

export interface EnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  /** The login shells to try; the account's, then zsh, bash and sh, unless a test names its own. */
  readonly shells?: readonly string[];
  /** Aborting ends a login shell's read: the launch environment is used. */
  readonly signal?: AbortSignal;
  /** Where a login shell's failure goes: main.log. */
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
   * start runs the owner's rc files once.
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

/** `EIDOLON_DESKTOP_LOGIN_SHELL` turned off in the launch environment, as both smokes turn it. */
export function loginShellOff(
  launch: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const raw = read(launch, "EIDOLON_DESKTOP_LOGIN_SHELL", platform)?.trim().toLowerCase();
  return raw !== undefined && FLAG_OFF.has(raw);
}

/**
 * `launch` with the login shell's variables over it, except the probe shell's own, `ELECTRON_*`,
 * which never come from the shell, and the `EIDOLON_*` that `launch` sets, so a smoke's or a
 * terminal's `EIDOLON_HOME` holds. A blank value counts as unset there, as everywhere in Eidolon.
 */
export function mergeShellEnvironment(
  launch: NodeJS.ProcessEnv,
  shell: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const merged = { ...launch };
  for (const [name, value] of Object.entries(shell)) {
    const folded = platform === "win32" ? name.toUpperCase() : name;
    if (SESSION.has(folded) || folded.startsWith("ELECTRON_")) continue;
    if (folded.startsWith("EIDOLON_") && read(launch, name, platform)) continue;
    write(merged, name, value, platform);
  }
  return merged;
}

/**
 * What the backend runs on before its own variables: on macOS the login shell's merged over
 * `launch`, unless `EIDOLON_DESKTOP_LOGIN_SHELL` is off or every shell fails, and on Windows
 * `launch` as it is. Never rejects; a shell that fails is logged.
 */
export async function readEnvironment(
  launch: NodeJS.ProcessEnv,
  { platform = process.platform, shells, signal, log = console }: EnvironmentOptions = {},
): Promise<EnvironmentRead> {
  if (platform === "win32" || loginShellOff(launch, platform)) {
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
