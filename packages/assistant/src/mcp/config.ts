// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/src/config.ts@ac78a60
//
// One entry of the `mcpServers` shape MCP clients share, checked field by field, since a pasted
// configuration is a trust boundary. Only stdio servers are taken: an HTTP one is refused with the
// way to reach it as a stdio one.

/** A server started as a local program that speaks MCP over stdin and stdout. */
export interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  /** Added to the environment the server gets. */
  env?: Record<string, string>;
  cwd?: string;
  /** What the server offers, in a sentence. */
  description?: string;
  /** Set to false to keep the entry without connecting. Default: true. */
  enabled?: boolean;
  /** Per-request timeout in seconds. */
  timeout?: number;
}

/**
 * A validated server entry, or why it is invalid. The config is the entry as given: fields the
 * validator does not know are kept, unchecked, for the caller to check.
 */
export type McpServerConfigResult =
  | { kind: "stdio"; config: McpStdioServerConfig & Record<string, unknown> }
  | { kind: "invalid"; error: string };

/** mcp-remote is a stdio server that reaches a Streamable HTTP or SSE one, signing in itself. */
export const HTTP_SERVERS_LATER = "HTTP servers come later: run it through mcp-remote";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const HTTP_TYPES: readonly unknown[] = ["http", "streamable-http", "sse"];
/**
 * setTimeout's longest delay, 2^31 - 1 ms, in whole seconds: a longer one fires at once, so every
 * request would time out. An hour in milliseconds, as some clients count it, is past it.
 */
const MAX_TIMEOUT_SECONDS = 2_147_483;

/**
 * Validate one entry of the `mcpServers` shape. Server names are letters, digits, `_` and `-`,
 * which tool names and namespaces are built from.
 */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfigResult {
  const invalid = (error: string): McpServerConfigResult => ({ kind: "invalid", error });
  if (!SERVER_NAME.test(name)) {
    return invalid(`invalid server name "${name}" (use letters, digits, "_" and "-")`);
  }
  if (!isRecord(raw)) return invalid(`server "${name}" must be an object`);
  const fieldsError = validateBaseFields(raw);
  if (fieldsError) return invalid(`server "${name}": ${fieldsError}`);
  const { type, url, command } = raw;
  if (HTTP_TYPES.includes(type) || (typeof url === "string" && type === undefined)) {
    return invalid(`server "${name}": ${HTTP_SERVERS_LATER}`);
  }
  // The cast below holds because the fields were checked one by one, which the types cannot
  // express.
  if (typeof command === "string" && (type === undefined || type === "stdio")) {
    const error = validateStdioFields(raw);
    if (error) return invalid(`server "${name}": ${error}`);
    return { kind: "stdio", config: raw as McpStdioServerConfig & Record<string, unknown> };
  }
  return invalid(`server "${name}" needs a "command" to run`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBaseFields(entry: Record<string, unknown>): string | undefined {
  const { enabled, timeout, description } = entry;
  if (enabled !== undefined && typeof enabled !== "boolean") return "enabled must be a boolean";
  if (description !== undefined && typeof description !== "string") {
    return "description must be a string";
  }
  if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
    return "timeout must be a positive number of seconds";
  }
  if (typeof timeout === "number" && !(timeout <= MAX_TIMEOUT_SECONDS)) {
    return `timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds`;
  }
  return undefined;
}

function validateStdioFields(entry: Record<string, unknown>): string | undefined {
  const { args, env, cwd } = entry;
  if (
    args !== undefined &&
    !(Array.isArray(args) && args.every((arg) => typeof arg === "string"))
  ) {
    return "args must be an array of strings";
  }
  if (env !== undefined && !isStringRecord(env)) return "env must map names to strings";
  if (cwd !== undefined && typeof cwd !== "string") return "cwd must be a string";
  return undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
