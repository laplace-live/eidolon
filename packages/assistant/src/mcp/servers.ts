// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/extensions/mcp/config.ts@ac78a60 and packages/coding-agent/src/core/mcp-servers.ts@ac78a60
//
// The owner's MCP servers, from `<data home>/mcp.json` in the `mcpServers` shape other clients
// share, with Cline's `disabled` and `alwaysAllow` and a `tools` list of what tasks get. Secrets
// are `${NAME}` references, filled from the environment, then credentials.json's `mcpSecrets`.
// A file that doesn't parse starts nothing and decides nothing.
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  envVariable,
  expandUser,
  isPlainObject,
  MCP_SECRETS_KEY,
  startsAtHome,
} from "@eidolon/config";
import { type McpStdioServerConfig, validateMcpServerConfig } from "./config.ts";
import { mcpNamespace } from "./naming.ts";

const CONFIG_FILE = "mcp.json";
const CREDENTIALS_FILE = "credentials.json";
/** pi's coding agent's default. */
const DEFAULT_TIMEOUT_SECONDS = 60;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** One server mcp.json declares, its fields checked. */
export interface McpServer {
  /** Its key in mcpServers. */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** As written, its `${NAME}` references unresolved. */
  readonly env: Readonly<Record<string, string>>;
  /** Absolute or under ~; without it the server starts where the session says. */
  readonly cwd?: string;
  /** The owner's words for what it offers. */
  readonly description?: string;
  /** Each request's, connecting included. */
  readonly timeoutMs: number;
  /** Neither `enabled: false` nor Cline's `disabled: true`. */
  readonly enabled: boolean;
  /** Tool names or `*` patterns: only these reach tasks. Absent: every tool. */
  readonly tools?: readonly string[];
  /** Exact tool names whose calls never ask. */
  readonly alwaysAllow: readonly string[];
}

/** Why mcp.json, or one entry of it, starts no server. */
export interface McpProblem {
  /** The entry's name; absent for the file as a whole. */
  readonly server?: string;
  readonly error: string;
  /** The entry is turned off, so no task tries to start it. */
  readonly off?: true;
  /** The entry isn't an object, which patchMcpServer can't change: only an edit of the file does. */
  readonly unchangeable?: true;
}

export interface McpConfig {
  readonly path: string;
  /** False when the file is there but isn't the mcpServers shape: it then decides nothing. */
  readonly readable: boolean;
  /** Every entry that checks out, enabled or not, in the file's order. */
  readonly servers: readonly McpServer[];
  readonly problems: readonly McpProblem[];
}

/** credentials.json's `mcpSecrets`: each name's value. */
export type McpSecrets = Readonly<Record<string, string>>;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Eidolon's fields, once pi's are valid. */
function validateOwnFields(config: Record<string, unknown>): string | undefined {
  const { tools, alwaysAllow, disabled, cwd } = config;
  if (tools !== undefined && !isStrings(tools)) return "tools must be an array of strings";
  if (alwaysAllow !== undefined && !isStrings(alwaysAllow)) {
    return "alwaysAllow must be an array of strings";
  }
  if (disabled !== undefined && typeof disabled !== "boolean") return "disabled must be a boolean";
  // A relative cwd would be the task's folder, where the worker's own files would run as the
  // owner's: an npx there runs a node_modules the task wrote ahead of the registry.
  if (typeof cwd === "string" && !isAbsolute(cwd) && cwd !== "~" && !startsAtHome(cwd)) {
    return "cwd must be an absolute path or start with ~/";
  }
  return undefined;
}

function serverOf(name: string, config: McpStdioServerConfig & Record<string, unknown>): McpServer {
  const { description, tools } = config;
  return {
    name,
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(description?.trim() ? { description: description.trim() } : {}),
    timeoutMs: (config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    enabled: config.enabled !== false && config.disabled !== true,
    ...(isStrings(tools) ? { tools } : {}),
    alwaysAllow: isStrings(config.alwaysAllow) ? config.alwaysAllow : [],
  };
}

/** mcp.json's servers from its text; `text` undefined: there is no file. */
export function parseMcpConfig(text: string | undefined, path: string): McpConfig {
  const unreadable = (error: string): McpConfig => ({
    path,
    readable: false,
    servers: [],
    problems: [{ error }],
  });
  let parsed: unknown;
  try {
    parsed = text === undefined ? {} : JSON.parse(stripBom(text));
  } catch {
    // JSON.parse's message quotes the text it stopped at, which can be a secret written in place.
    return unreadable(`${path} isn't valid JSON`);
  }
  if (
    !isPlainObject(parsed) ||
    (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers))
  ) {
    return unreadable(`${path}: expected an object with an "mcpServers" object`);
  }
  const servers: McpServer[] = [];
  const problems: McpProblem[] = [];
  for (const [name, raw] of Object.entries(parsed.mcpServers ?? {})) {
    const off = isPlainObject(raw) && (raw.enabled === false || raw.disabled === true);
    const problem = (error: string) =>
      problems.push({
        server: name,
        error,
        ...(off ? { off: true as const } : {}),
        ...(isPlainObject(raw) ? {} : { unchangeable: true as const }),
      });
    const result = validateMcpServerConfig(name, raw);
    if (result.kind === "invalid") {
      problem(result.error);
      continue;
    }
    const own = validateOwnFields(result.config);
    if (own !== undefined) {
      problem(`server "${name}": ${own}`);
      continue;
    }
    // Names that differ only in `-` and `_` would share a namespace.
    const clash = servers.find((other) => mcpNamespace(other.name) === mcpNamespace(name));
    if (clash !== undefined) {
      problem(`server "${name}" conflicts with "${clash.name}"`);
      continue;
    }
    servers.push(serverOf(name, result.config));
  }
  return { path, readable: true, servers, problems };
}

/** `<dataHome>/mcp.json` as it is now; no file is no servers. */
export async function readMcpConfig(dataHome: string): Promise<McpConfig> {
  const path = join(dataHome, CONFIG_FILE);
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== "ENOENT") {
      return { path, readable: false, servers: [], problems: [{ error: `${path}: ${code}` }] };
    }
  }
  return parseMcpConfig(text, path);
}

/** credentials.json's `mcpSecrets`, its non-empty strings; nothing when it can't be read. */
export async function readMcpSecrets(dataHome: string): Promise<McpSecrets> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(await readFile(join(dataHome, CREDENTIALS_FILE), "utf8")));
  } catch {
    return {};
  }
  const secrets = isPlainObject(parsed) ? parsed[MCP_SECRETS_KEY] : undefined;
  if (!isPlainObject(secrets)) return {};
  return Object.fromEntries(
    Object.entries(secrets).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}

/** `${NAME}`'s value: the environment's, then mcpSecrets'. Blank is unset in both. */
export function mcpSecretValue(name: string, secrets: McpSecrets): string | undefined {
  return envVariable(name) ?? ((Object.hasOwn(secrets, name) && secrets[name]) || undefined);
}

/** Every `${NAME}` an entry references, in its args, then its env, once each. */
export function mcpReferences(server: McpServer): string[] {
  const names = new Set<string>();
  for (const text of [...server.args, ...Object.values(server.env)]) {
    for (const [, name] of text.matchAll(REFERENCE)) names.add(name as string);
  }
  return [...names];
}

/** What an entry runs, with `~` expanded and every reference filled. */
export interface ResolvedMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Each reference's value, by its name. */
  readonly secrets: ReadonlyMap<string, string>;
}

/** The entry ready to run, or the first reference that has no value. */
export function resolveMcpServer(
  server: McpServer,
  secrets: McpSecrets,
): ResolvedMcpServer | { readonly missing: string } {
  const values = new Map<string, string>();
  for (const name of mcpReferences(server)) {
    const value = mcpSecretValue(name, secrets);
    if (value === undefined) return { missing: name };
    values.set(name, value);
  }
  const fill = (text: string) =>
    text.replace(REFERENCE, (_, name: string) => values.get(name) as string);
  return {
    command: expandUser(server.command),
    args: server.args.map((arg) => fill(expandUser(arg))),
    env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, fill(value)])),
    ...(server.cwd === undefined ? {} : { cwd: expandUser(server.cwd) }),
    secrets: values,
  };
}

/** Whether a tool name matches any of the entries, each an exact name or a `*` pattern. */
export function toolNameMatcher(entries: readonly string[]): (name: string) => boolean {
  const names = new Set(entries.filter((entry) => !entry.includes("*")));
  const patterns = entries
    .filter((entry) => entry.includes("*"))
    .map((pattern) => {
      const source = pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${source}$`);
    });
  return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

/** What mcp.json says now of a call to `tool` on `server`, read at each call. */
export type McpStanding = "off" | "always" | "ask";

/**
 * "off" when the owner turned the server off or took it out; "always" when they chose Always for
 * the tool; else "ask". A file that doesn't parse, or an entry that doesn't, decides nothing.
 */
export function mcpStanding(config: McpConfig, server: string, tool: string): McpStanding {
  if (!config.readable) return "ask";
  const entry = config.servers.find((each) => each.name === server);
  if (entry === undefined) {
    const problem = config.problems.find((each) => each.server === server);
    return problem === undefined || problem.off ? "off" : "ask";
  }
  if (!entry.enabled) return "off";
  return entry.alwaysAllow.includes(tool) ? "always" : "ask";
}

/** What the owner changes of one server from the app. */
export interface McpServerPatch {
  /** On deletes `enabled` and Cline's `disabled`; off sets `enabled: false`. */
  readonly enabled?: boolean;
  /** A tool to add to `alwaysAllow`. */
  readonly allow?: string;
  /** A tool to take out of `alwaysAllow`. */
  readonly revoke?: string;
}

export type McpPatchResult =
  | { readonly kind: "patched"; readonly text: string }
  | { readonly kind: "unknown-server" }
  | { readonly kind: "invalid-config" };

/**
 * mcp.json's new text with `patch` applied to `name`'s entry, every other key kept and the file's
 * indentation with it. `text` undefined: there is no file. A file that doesn't parse is never
 * written over.
 */
export function patchMcpServer(
  text: string | undefined,
  name: string,
  patch: McpServerPatch,
): McpPatchResult {
  let parsed: unknown;
  try {
    parsed = text === undefined ? {} : JSON.parse(stripBom(text));
  } catch {
    return { kind: "invalid-config" };
  }
  if (
    !isPlainObject(parsed) ||
    (parsed.mcpServers !== undefined && !isPlainObject(parsed.mcpServers))
  ) {
    return { kind: "invalid-config" };
  }
  const servers = parsed.mcpServers;
  const server = isPlainObject(servers) && Object.hasOwn(servers, name) ? servers[name] : undefined;
  if (!isPlainObject(server)) return { kind: "unknown-server" };
  if (patch.enabled === true) {
    delete server.enabled;
    delete server.disabled;
  } else if (patch.enabled === false) {
    server.enabled = false;
  }
  if (patch.allow !== undefined || patch.revoke !== undefined) {
    const allowed = (isStrings(server.alwaysAllow) ? server.alwaysAllow : []).filter(
      (tool) => tool !== patch.revoke,
    );
    if (patch.allow !== undefined && !allowed.includes(patch.allow)) allowed.push(patch.allow);
    if (allowed.length > 0) server.alwaysAllow = allowed;
    else delete server.alwaysAllow;
  }
  const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
  return { kind: "patched", text: `${JSON.stringify(parsed, null, indent)}\n` };
}
