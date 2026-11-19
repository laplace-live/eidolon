// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/coding-agent/src/extensions/mcp/runtime.ts@ac78a60
//
// One task's MCP servers, started together at its first run and killed, process groups and all,
// when it ends. Each runs in a folder no task can write, with the task's cut environment plus its
// entry's own, and every secret one was given is hidden in the errors and stderr it hands back.
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { errorText } from "@eidolon/config";
import { shellEnv } from "../tools/shell.ts";
import { sliceTail } from "../tools/truncate.ts";
import type { AssistantTool, PathGuard } from "../types.ts";
import { McpClient } from "./client.ts";
import type { Tool } from "./protocol/types.ts";
import {
  type McpConfig,
  type McpSecrets,
  type McpServer,
  type ResolvedMcpServer,
  resolveMcpServer,
  toolNameMatcher,
} from "./servers.ts";
import {
  capMcpTools,
  createMcpTool,
  type McpLeftOut,
  mcpToolSchema,
  nameMcpTools,
  STDERR_TAIL_CHARS,
} from "./tools.ts";
import { StdioTransport } from "./transports/stdio.ts";

/** A value this short isn't hidden: DEBUG=1 would garble every message, and hides no secret. */
const MIN_SECRET_CHARS = 6;

export interface McpSessionOptions {
  /** mcp.json as readMcpConfig read it. */
  readonly config: McpConfig;
  /** What `${NAME}` takes when the environment has no value. */
  readonly secrets: McpSecrets;
  /** Where a server without its own cwd starts: a folder no task may write, made 0700. */
  readonly cwd: string;
  /**
   * The task's: its folder is every server's root, and the PATH the servers get leaves out what it
   * may write.
   */
  readonly guard: PathGuard;
  /** This app's version, which the servers are told with its name. */
  readonly version: string;
  /** Stops the opening: every server it started is closed, and open throws the signal's reason. */
  readonly signal: AbortSignal;
}

/** The server and tool behind one of the worker's tool names. */
export interface McpToolRef {
  readonly server: string;
  readonly tool: string;
  /** What the server claims of the tool, which never decides anything. */
  readonly hint?: "read-only" | "destructive";
}

/** A server that didn't start, or mcp.json itself (no server), and why. */
export interface McpFailure {
  readonly server?: string;
  readonly error: string;
}

interface Started {
  readonly server: McpServer;
  readonly client: McpClient;
  readonly transport: StdioTransport;
  readonly tools: readonly Tool[];
  /** Hides the values this server's references resolved to. */
  readonly redact: (text: string) => string;
}

/**
 * Each resolved value in `text` replaced by the `${NAME}` it came from, the longest first. Only
 * the server's own: a reference can hold what isn't a secret, such as a folder.
 */
function redactor(secrets: ReadonlyMap<string, string>): (text: string) => string {
  const hidden = [...secrets]
    .filter(([, value]) => value.length >= MIN_SECRET_CHARS)
    .sort(([, a], [, b]) => b.length - a.length);
  return (text) =>
    hidden.reduce((out, [name, value]) => out.replaceAll(value, `\${${name}}`), text);
}

function hintOf(tool: Tool): McpToolRef["hint"] {
  if (tool.annotations?.readOnlyHint === true) return "read-only";
  return tool.annotations?.destructiveHint === true ? "destructive" : undefined;
}

/** Connects to one server within its timeout, or says why it couldn't. */
async function start(
  server: McpServer,
  resolved: ResolvedMcpServer,
  env: Readonly<Record<string, string>>,
  options: McpSessionOptions,
): Promise<Started | McpFailure> {
  const redact = redactor(resolved.secrets);
  const transport = new StdioTransport({
    command: resolved.command,
    args: resolved.args,
    cwd: resolved.cwd ?? options.cwd,
    env: { ...env, ...resolved.env },
  });
  const folder = options.guard.folder;
  const client = new McpClient({
    name: "eidolon",
    version: options.version,
    requestTimeoutMs: server.timeoutMs,
    roots: [{ uri: pathToFileURL(folder).href, name: basename(folder) }],
  });
  // Closing the client fails its pending requests and kills the server. Kept, since a second
  // close() returns before the first has finished closing the transport.
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= client.close().catch(() => {});
    return closing;
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void close();
  }, server.timeoutMs);
  options.signal.addEventListener("abort", close, { once: true });
  try {
    await client.connect(transport);
    // Servers without the tools capability (prompts or resources only) don't answer tools/list.
    const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
    if (client.connectionState !== "connected") throw new Error("connection closed during setup");
    return { server, client, transport, tools, redact };
  } catch (error) {
    await close();
    const why = redact(
      timedOut ? `didn't answer within ${server.timeoutMs / 1000} s` : errorText(error),
    );
    // Hidden before it is cut, so no cut splits a secret.
    const stderr = sliceTail(redact(transport.stderr.trim()), STDERR_TAIL_CHARS);
    return { server: server.name, error: stderr ? `${why}\n${stderr}` : why };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", close);
  }
}

export class McpSession {
  /** Every connected server's tools within the limits, in mcp.json's order, then each server's. */
  readonly tools: readonly AssistantTool[];
  readonly failed: readonly McpFailure[];
  readonly left: readonly McpLeftOut[];
  readonly #refs: ReadonlyMap<string, McpToolRef>;
  readonly #started: readonly Started[];
  #closing: Promise<void> | undefined;

  private constructor(started: readonly Started[], failed: readonly McpFailure[]) {
    this.#started = started;
    this.failed = failed;
    const listed: { from: Started; tool: Tool }[] = [];
    for (const from of started) {
      const allowed = from.server.tools === undefined ? null : toolNameMatcher(from.server.tools);
      const seen = new Set<string>();
      for (const tool of from.tools) {
        if (seen.has(tool.name) || (allowed !== null && !allowed(tool.name))) continue;
        seen.add(tool.name);
        listed.push({ from, tool });
      }
    }
    const names = nameMcpTools(
      listed.map(({ from, tool }) => ({ server: from.server.name, tool: tool.name })),
    );
    const { taken, left } = capMcpTools(
      listed.map(({ from, tool }, index) => ({
        from,
        tool,
        server: from.server.name,
        schema: mcpToolSchema(names[index] as string, from.server.name, tool),
      })),
    );
    this.tools = taken.map(({ from, tool, schema }) =>
      createMcpTool({
        schema,
        server: from.server.name,
        tool,
        ...(from.server.description === undefined ? {} : { description: from.server.description }),
        client: from.client,
        timeoutMs: from.server.timeoutMs,
        stderr: () => from.transport.stderr,
        redact: from.redact,
      }),
    );
    this.#refs = new Map(
      taken.map(({ server, tool, schema }) => {
        const hint = hintOf(tool);
        return [schema.name, { server, tool: tool.name, ...(hint ? { hint } : {}) }];
      }),
    );
    this.left = left;
  }

  /**
   * Starts every enabled server in parallel, each within its own timeout. One that can't start, or
   * whose secret has no value, is in `failed`, and the task works without it.
   */
  static async open(options: McpSessionOptions): Promise<McpSession> {
    const { config, signal } = options;
    signal.throwIfAborted();
    const failed: McpFailure[] = config.problems
      .filter((problem) => !problem.off)
      .map(({ server, error }) => (server === undefined ? { error } : { server, error }));
    const ready: { server: McpServer; resolved: ResolvedMcpServer }[] = [];
    for (const server of config.servers) {
      if (!server.enabled) continue;
      const resolved = resolveMcpServer(server, options.secrets);
      if ("missing" in resolved) {
        failed.push({
          server: server.name,
          error: `${server.name} needs ${resolved.missing}: set it in credentials.json's mcpSecrets or in the environment`,
        });
        continue;
      }
      ready.push({ server, resolved });
    }
    if (ready.length === 0) return new McpSession([], failed);
    await mkdir(options.cwd, { recursive: true, mode: 0o700 });
    const env = await shellEnv(options.guard);
    signal.throwIfAborted();
    const outcomes = await Promise.all(
      ready.map(({ server, resolved }) => start(server, resolved, env, options)),
    );
    const started = outcomes.filter((outcome): outcome is Started => "client" in outcome);
    const closeStarted = () =>
      Promise.all(started.map(({ client }) => client.close().catch(() => {})));
    if (signal.aborted) {
      await closeStarted();
      throw signal.reason;
    }
    for (const outcome of outcomes) if (!("client" in outcome)) failed.push(outcome);
    try {
      return new McpSession(started, failed);
    } catch (error) {
      // What the servers listed is read here: a listing nothing expected leaves none running.
      await closeStarted();
      throw error;
    }
  }

  /** The server and tool a worker's tool name calls; undefined for a name that isn't MCP's. */
  toolOf(name: string): McpToolRef | undefined {
    return this.#refs.get(name);
  }

  /** Closes every server, killing its process group; resolves once all of them are gone. */
  close(): Promise<void> {
    this.#closing ??= Promise.all(
      this.#started.map(({ client }) => client.close().catch(() => {})),
    ).then(() => {});
    return this.#closing;
  }
}
