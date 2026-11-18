// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/src/transports/stdio.ts@ac78a60
//
// A server as a program on this computer, in a process group of its own, so that closing it ends
// what it started too, such as the server npx starts under it. It gets the environment it is given
// and nothing of this process's.
import { type ChildProcess, spawn } from "node:child_process";
import { type JsonRpcMessage, McpConnectionClosedError } from "../protocol/jsonrpc.ts";
import { JsonRpcLineReader } from "./lines.ts";
import { type McpTransport, TransportEvents } from "./transport.ts";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** How long a server gets to exit on its own after stdin closes, before it is sent SIGTERM. */
const STDIN_CLOSE_GRACE_MS = 500;

/** Process groups of running servers, killed if the host exits without closing them. */
const liveProcessGroups = new Set<number>();
let exitHookInstalled = false;

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      // Negative pid: the whole group, so wrappers like `npx` do not leave the server behind.
      process.kill(-pid, signal);
      return;
    } catch {
      // The group is gone or was never created; fall back to the direct child.
    }
  }
  try {
    child.kill(signal);
  } catch {}
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const pid of liveProcessGroups) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
    }
  });
}

export interface StdioTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** The server's whole environment. */
  env?: Readonly<Record<string, string>>;
  maxMessageBytes?: number;
  maxStderrBytes?: number;
  /** Time to wait for the server to exit after SIGTERM before sending SIGKILL. Default: 2000. */
  closeTimeoutMs?: number;
}

export class StdioTransport extends TransportEvents implements McpTransport {
  readonly options: Readonly<StdioTransportOptions>;
  #child: ChildProcess | undefined;
  readonly #lines: JsonRpcLineReader;
  #started = false;
  #closed = false;

  constructor(options: StdioTransportOptions) {
    super();
    this.options = Object.freeze({
      ...options,
      args: options.args ? [...options.args] : undefined,
    });
    this.#lines = new JsonRpcLineReader({
      maxMessageBytes: this.options.maxMessageBytes,
      maxStderrBytes: this.options.maxStderrBytes,
      onMessage: (message) => this.emitMessage(message),
      onError: (error) => this.emitError(error),
    });
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get stderr(): string {
    return this.#lines.stderr;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error("MCP stdio transport already started");
    if (this.#closed) throw new McpConnectionClosedError();
    this.#started = true;
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so closing the transport can terminate the server's children too.
      detached: true,
    });
    this.#child = child;
    const pid = child.pid;
    if (pid !== undefined) {
      installExitHook();
      liveProcessGroups.add(pid);
      // Not on "exit": children of the server can outlive it while still holding its pipes.
      child.once("close", () => liveProcessGroups.delete(pid));
    }
    child.stdout?.on("data", (chunk: Buffer) => this.#lines.readStdout(chunk));
    child.stdout?.on("error", (error) => this.emitError(error));
    child.stdin?.on("error", (error) => {
      if (!this.#closed) this.emitError(error);
    });
    child.stderr?.on("data", (chunk: Buffer) => this.#lines.readStderr(chunk));
    child.stderr?.on("error", (error) => this.emitError(error));
    child.on("close", () => {
      this.#child = undefined;
      this.#lines.end();
      this.emitClose();
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    child.on("error", (error) => {
      if (!this.#closed) this.emitError(error);
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const stdin = this.#child?.stdin;
    if (!this.#started || this.#closed || !stdin?.writable) throw new McpConnectionClosedError();
    const payload = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    if (!child) {
      this.emitClose();
      return;
    }
    // A server that already exited can leave children holding its pipes; the group cleanup below
    // still has to run for them. Shutdown per the spec: close stdin and let the server exit, then
    // SIGTERM, then SIGKILL.
    const closeTimeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    await new Promise<void>((resolve) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      child.once("close", () => {
        for (const timer of timers) clearTimeout(timer);
        // Children of the server that ignored stdin closing would otherwise outlive it.
        killProcessTree(child, "SIGTERM");
        resolve();
      });
      const grace = Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);
      timers.push(setTimeout(() => killProcessTree(child, "SIGTERM"), grace));
      timers.push(setTimeout(() => killProcessTree(child, "SIGKILL"), grace + closeTimeoutMs));
      child.stdin?.end();
    });
  }
}
