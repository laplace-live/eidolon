// Copyright (c) 2026 DeepSeek
// SPDX-License-Identifier: MIT
//
// Ported from deepseek-harness apps/desktop/src/login-shell-environment.ts@2e39e70496
//
// The backend's environment: on macOS the owner's login shell's over the one the app was launched
// with, on Windows the launch environment as it is, plus what runs the app's binary as the
// backend's Node.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type LoginShellFailure, PROBE_ENVIRONMENT, readLoginShell } from "./login-shell.ts";

/** They describe the probe's own shell process, not the owner's configuration. */
const SESSION = new Set(["PWD", "OLDPWD", "SHLVL", "_", ...Object.keys(PROBE_ENVIRONMENT)]);

/** As @eidolon/config's envFlag reads a flag that defaults to on. */
const FLAG_OFF = new Set(["false", "0", "no", "off"]);

export interface BackendEnvironment {
  readonly env: NodeJS.ProcessEnv;
  /** The login shells that gave nothing, in the order tried; empty when none was read. */
  readonly failures: readonly LoginShellFailure[];
}

export interface BackendEnvironmentOptions {
  /**
   * The payload's folder, for `EIDOLON_APP_ROOT`; null for the dev backend, which runs from the
   * checkout and finds its files there.
   */
  readonly appRoot: string | null;
  readonly platform?: NodeJS.Platform;
  /** The login shells to try; the account's, then zsh, bash and sh, unless a test names its own. */
  readonly shells?: readonly string[];
  /** Aborting ends a login shell's read: the launch environment is used. */
  readonly signal?: AbortSignal;
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

function remove(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): void {
  for (const key of keysOf(env, name, platform)) delete env[key];
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

/** `env` as the backend runs on it: the app's binary as Node, the payload's files, and no .env. */
export function withBackendVariables(
  env: NodeJS.ProcessEnv,
  appRoot: string | null,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const out = { ...env };
  if (appRoot === null) remove(out, "EIDOLON_APP_ROOT", platform);
  else write(out, "EIDOLON_APP_ROOT", appRoot, platform);
  write(out, "EIDOLON_NO_DOTENV", "1", platform);
  write(out, "ELECTRON_RUN_AS_NODE", "1", platform);
  return out;
}

/**
 * The environment for one spawn of the backend, read afresh each time so a restart sees a changed
 * PATH: on macOS the login shell's merged over `launch`, unless `EIDOLON_DESKTOP_LOGIN_SHELL` is
 * off or every shell fails, and on Windows `launch` as it is. Never rejects.
 */
export async function backendEnvironment(
  launch: NodeJS.ProcessEnv,
  { appRoot, platform = process.platform, shells, signal }: BackendEnvironmentOptions,
): Promise<BackendEnvironment> {
  if (platform === "win32" || loginShellOff(launch, platform)) {
    return { env: withBackendVariables(launch, appRoot, platform), failures: [] };
  }
  const { variables, failures } = await readLoginShell(launch, { shells, signal });
  const env = variables === null ? launch : mergeShellEnvironment(launch, variables, platform);
  return { env: withBackendVariables(env, appRoot, platform), failures };
}

/** The data home the backend finds in `env`, as @eidolon/config's dataHome() does. */
export function dataHome(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = read(env, "EIDOLON_HOME", platform);
  if (!configured) return join(homedir(), ".laplace", "eidolon");
  if (configured === "~") return homedir();
  const atHome =
    configured.startsWith("~/") || (platform === "win32" && configured.startsWith("~\\"));
  return resolve(atHome ? join(homedir(), configured.slice(2)) : configured);
}
