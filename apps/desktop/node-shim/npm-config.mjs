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

/** `text` with each ${VAR} npm's config expands from `env`: none when unset, `${VAR?}` empty. */
export function envReplace(text, env) {
  return text.replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g, (whole, escapes, name, optional) => {
    // An odd run of backslashes escapes the ${, and each pair before it is one backslash.
    if (escapes.length % 2 === 1) return whole.slice((escapes.length + 1) / 2);
    const value = env[name] ?? (optional === "?" ? "" : `\${${name}}`);
    return escapes.slice(escapes.length / 2) + value;
  });
}

/** A key or value of an .npmrc line as npm's ini parser reads it: quoted, it is JSON's. */
function iniWord(raw) {
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
    const char = word[at];
    if (char === ";" || char === "#") break;
    if (char !== "\\") out += char;
    else if (at + 1 === word.length) out += "\\";
    else out += "\\;#".includes(word[at + 1]) ? word[++at] : `\\${word[++at]}`;
  }
  return out.trim();
}

/** The settings an .npmrc gives before any [section], decoded as npm's ini parser does. */
function iniDecode(text) {
  const settings = {};
  for (const line of text.split(/[\r\n]+/)) {
    if (/^\s*(?:[;#]|$)/.test(line)) continue;
    const match = /^\[[^\]]*\]\s*$|^([^=]+)(=(.*))?$/.exec(line);
    if (match === null) continue;
    if (match[1] === undefined) break;
    const raw = String(iniWord(match[1]));
    const list = raw.length > 2 && raw.endsWith("[]");
    const key = list ? raw.slice(0, -2) : raw;
    if (key === "__proto__") continue;
    const word = match[2] ? iniWord(match[3]) : true;
    const value = word === "true" || word === "false" || word === "null" ? JSON.parse(word) : word;
    if (list && !Object.hasOwn(settings, key)) settings[key] = [];
    else if (list && !Array.isArray(settings[key])) settings[key] = [settings[key]];
    if (Array.isArray(settings[key])) settings[key].push(value);
    else settings[key] = value;
  }
  return settings;
}

/**
 * The settings an .npmrc gives before any [section], as npm reads them: `key[]` lines as a list,
 * and each ${VAR} in a key or value expanded from `env`.
 */
function readNpmrc(file, env) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  // npm expands the keys of the file as decoded, so of two that expand alike, the one the file
  // first names later wins.
  const asRead = (value) =>
    typeof value === "string" ? envReplace(value.trim(), env) : JSON.stringify(value);
  const settings = {};
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
export function npmConfig(env, prefix, home) {
  const variables = {};
  for (const [name, value] of Object.entries(env)) {
    const key = /^npm_config_(.+)$/i.exec(name)?.[1];
    if (key === undefined || !value) continue;
    const setting = envReplace(
      key.startsWith("//") ? key : key.replace(/(?!^)_/g, "-").toLowerCase(),
      env,
    );
    if (setting !== "__proto__") variables[setting] = envReplace(value.trim(), env);
  }
  const user = path.resolve(variables.userconfig ?? path.join(home, ".npmrc"));
  const project = path.join(prefix, ".npmrc");
  return [variables, project === user ? {} : readNpmrc(project, env), readNpmrc(user, env)];
}

/** A setting from the highest of npm's config `sources` that gives it. */
export const settingOf = (sources, key) =>
  sources.find((source) => Object.hasOwn(source, key))?.[key];

/**
 * npm's error, as it prints it, for the config `sources` npmConfig reads that npm runs no command
 * under: a registry that isn't a URL, or credentials the user's or the project's .npmrc gives no
 * registry; undefined for none.
 */
export function invalidConfig(sources) {
  let nerfed;
  try {
    const registry = new URL(settingOf(sources, "registry") ?? "https://registry.npmjs.org/");
    const dir = new URL(".", `${registry.protocol}//${registry.host}${registry.pathname}`);
    nerfed = `//${dir.host}${dir.pathname}`;
  } catch {
    return "code ERR_INVALID_URL\nInvalid URL";
  }
  const problems = [];
  for (const [where, source = {}] of [
    ["user", sources[2]],
    ["project", sources[1]],
  ]) {
    const given = (key) => !["", "false", "null", undefined].includes(source[key]);
    const refused = (key) => `\`${key}\` is not allowed in ${where} config`;
    for (const key of ["_authtoken", "-authtoken"]) if (given(key)) problems.push(refused(key));
    for (const key of ["_auth", "_authToken", "username", "_password"]) {
      if (!given(key)) continue;
      // npm takes a username and a password only together.
      const other = { username: "_password", _password: "username" }[key];
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
