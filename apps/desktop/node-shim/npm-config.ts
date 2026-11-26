// Copyright (c) npm, Inc.
// Copyright (c) Isaac Z. Schlueter and Contributors
// SPDX-License-Identifier: ISC
//
// Ported from @npmcli/config lib/env-replace.js, lib/errors.js, lib/index.js, lib/nerf-dart.js and
// lib/parse-field.js@10.12.0, and ini lib/ini.js@6.0.0
//
// npm's config as npx reads it: its npm_config_* variables and .npmrc files, each ${VAR} expanded,
// and the auth config npm runs no command under.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Env } from "./npm-exec.ts";

export type ConfigValue = string | string[];
export type ConfigSource = Record<string, ConfigValue | undefined>;

/** `text` with each ${VAR} npm's config expands from `env`: none when unset, `${VAR?}` empty. */
export function envReplace(text: string, env: Env): string {
  return text.replace(
    /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g,
    (whole, escapes: string, name: string, optional: string | undefined) => {
      // An odd run of backslashes escapes the ${, and each pair before it is one backslash.
      if (escapes.length % 2 === 1) return whole.slice((escapes.length + 1) / 2);
      const value = env[name] ?? (optional === "?" ? "" : `\${${name}}`);
      return escapes.slice(escapes.length / 2) + value;
    },
  );
}

/** A key or value of an .npmrc line as npm's ini parser reads it: quoted, it is JSON's. */
function iniWord(raw: string): unknown {
  const word = raw.trim();
  const quote = word[0];
  if ((quote === '"' || quote === "'") && word.endsWith(quote)) {
    const inner = word.startsWith("'") ? word.slice(1, -1) : word;
    try {
      return JSON.parse(inner);
    } catch {
      return inner;
    }
  }
  // Unquoted, it ends at a ; or # comment, and \; \# \\ stand for the character.
  let out = "";
  for (let at = 0; at < word.length; at++) {
    const char = word[at] as string;
    if (char === ";" || char === "#") break;
    if (char !== "\\") out += char;
    else if (at + 1 === word.length) out += "\\";
    else {
      const next = word[at + 1] as string;
      out += "\\;#".includes(next) ? (word[++at] as string) : `\\${word[++at]}`;
    }
  }
  return out.trim();
}

/** The settings an .npmrc gives before any [section], decoded as npm's ini parser does. */
function iniDecode(text: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const line of text.split(/[\r\n]+/)) {
    if (/^\s*(?:[;#]|$)/.test(line)) continue;
    const match = /^\[[^\]]*\]\s*$|^([^=]+)(=(.*))?$/.exec(line);
    if (match === null) continue;
    if (match[1] === undefined) break;
    const raw = String(iniWord(match[1]));
    const list = raw.length > 2 && raw.endsWith("[]");
    const key = list ? raw.slice(0, -2) : raw;
    if (key === "__proto__") continue;
    const word = match[2] ? iniWord(match[3] ?? "") : true;
    const value = word === "true" || word === "false" || word === "null" ? JSON.parse(word) : word;
    if (list && !Object.hasOwn(settings, key)) settings[key] = [];
    else if (list && !Array.isArray(settings[key])) settings[key] = [settings[key]];
    if (Array.isArray(settings[key])) (settings[key] as unknown[]).push(value);
    else settings[key] = value;
  }
  return settings;
}

/**
 * The settings an .npmrc gives before any [section], as npm reads them: `key[]` lines as a list,
 * and each ${VAR} in a key or value expanded from `env`.
 */
function readNpmrc(file: string, env: Env): ConfigSource {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  // npm expands the keys of the file as decoded, so of two that expand alike, the one the file
  // first names later wins.
  const asRead = (value: unknown): string =>
    typeof value === "string" ? envReplace(value.trim(), env) : JSON.stringify(value);
  const settings: ConfigSource = {};
  for (const [raw, value] of Object.entries(iniDecode(text))) {
    const key = envReplace(raw, env);
    if (key !== "__proto__") {
      settings[key] = Array.isArray(value) ? value.map(asRead) : asRead(value);
    }
  }
  return settings;
}

/**
 * npm's config sources npx reads, highest first, each as `{ key: value }`: the npm_config_*
 * variables in `env`, the .npmrc at npm's local `prefix`, then the user's, ${VAR} expanded as npm
 * expands them.
 */
export function npmConfig(env: Env, prefix: string, home: string): ConfigSource[] {
  const variables: ConfigSource = {};
  for (const [name, value] of Object.entries(env)) {
    const key = /^npm_config_(.+)$/i.exec(name)?.[1];
    if (key === undefined || !value) continue;
    const setting = envReplace(
      key.startsWith("//") ? key : key.replace(/(?!^)_/g, "-").toLowerCase(),
      env,
    );
    if (setting !== "__proto__") variables[setting] = envReplace(value.trim(), env);
  }
  const user = userConfig(variables, home);
  const project = path.join(prefix, ".npmrc");
  return [variables, project === user ? {} : readNpmrc(project, env), readNpmrc(user, env)];
}

/** A setting from the highest of npm's config `sources` that gives it. */
export const settingOf = (sources: readonly ConfigSource[], key: string): ConfigValue | undefined =>
  sources.find((source) => Object.hasOwn(source, key))?.[key];

/** The file a setting of npm's path type names: after a ~/ from `home`, else from `cwd`. */
export function settingPath(
  text: string,
  cwd: string,
  home: string,
  platform: string = process.platform,
): string {
  const fromHome = (platform === "win32" ? /^~[/\\]/ : /^~\//).test(text);
  return fromHome ? path.resolve(home, text.slice(2)) : path.resolve(cwd, text);
}

/** The user .npmrc npm reads: the one its `userconfig` variable names, from `cwd`, or home's. */
export function userConfig(
  variables: ConfigSource,
  home: string,
  cwd: string = process.cwd(),
): string {
  const configured = variables.userconfig;
  return typeof configured === "string" && configured
    ? settingPath(configured, cwd, home)
    : path.join(home, ".npmrc");
}

/**
 * npm's error, as it prints it, for the config `sources` npmConfig reads that npm runs no command
 * under: a registry that isn't a URL, or credentials the user's or the project's .npmrc gives no
 * registry; undefined for none.
 */
export function invalidConfig(sources: readonly ConfigSource[]): string | undefined {
  let nerfed: string;
  try {
    const raw = settingOf(sources, "registry");
    const registry = new URL(String(raw ?? "https://registry.npmjs.org/"));
    const dir = new URL(".", `${registry.protocol}//${registry.host}${registry.pathname}`);
    nerfed = `//${dir.host}${dir.pathname}`;
  } catch {
    return "code ERR_INVALID_URL\nInvalid URL";
  }
  const problems: string[] = [];
  for (const [where, source = {}] of [
    ["user", sources[2]],
    ["project", sources[1]],
  ] as const) {
    const given = (key: string): boolean => {
      const value = source[key];
      return (
        value !== undefined && (Array.isArray(value) || !["", "false", "null"].includes(value))
      );
    };
    const refused = (key: string) => `\`${key}\` is not allowed in ${where} config`;
    for (const key of ["_authtoken", "-authtoken"]) if (given(key)) problems.push(refused(key));
    const pairs: Readonly<Record<string, string>> = {
      username: "_password",
      _password: "username",
    };
    for (const key of ["_auth", "_authToken", "username", "_password"]) {
      if (!given(key)) continue;
      // npm takes a username and a password only together.
      const other = pairs[key];
      problems.push(
        other !== undefined && !given(other)
          ? refused(key)
          : `\`${key}\` must be renamed to \`${nerfed}:${key}\` in ${where} config`,
      );
    }
  }
  if (problems.length === 0) return undefined;
  return [
    "code ERR_INVALID_AUTH",
    `Invalid auth configuration found: ${problems.join(", ")}`,
    // npm's line, its stray backtick too.
    "Please run `npm config fix` to repair your configuration.`",
  ].join("\n");
}
