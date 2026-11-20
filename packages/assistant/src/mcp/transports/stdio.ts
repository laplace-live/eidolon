// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/src/transports/stdio.ts@ac78a60, its Windows parts @cb1205e
//
// A server as a program on this computer, in a process group of its own, so that closing it ends
// what it started too, such as the server npx starts under it. It gets the environment it is given
// and nothing of this process's. Windows has no process groups: there closing a server kills its
// tree through taskkill, and one this process leaves behind by dying reads its stdin's end.
import type { ChildProcess } from "node:child_process";
import { killTree } from "@eidolon/config";
import crossSpawn from "cross-spawn";
import { type JsonRpcMessage, McpConnectionClosedError } from "../protocol/jsonrpc.ts";
import { JsonRpcLineReader } from "./lines.ts";
import { type McpTransport, TransportEvents } from "./transport.ts";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
/** How long a server gets to exit on its own after stdin closes, before it is sent SIGTERM. */
const STDIN_CLOSE_GRACE_MS = 500;
/** After the SIGKILL, how long the server's pipes get to close before they are let go. */
const PIPE_DRAIN_MS = 1_000;

const WINDOWS = process.platform === "win32";

/**
 * Process groups that may still hold a server or what it started, killed if the host exits; on
 * Windows, the servers still running, whose trees are.
 */
const liveProcessGroups = new Set<number>();
let exitHookInstalled = false;

/** Signals process group `pid`; false once no process is left in it. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  // Every kill there is TerminateProcess, which would leave what the server started; and a pid
  // whose process is gone may be another's.
  if (WINDOWS) {
    if (pid !== undefined && child.exitCode === null && child.signalCode === null) killTree(pid);
    return;
  }
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
  // Not SIGTERM: once this process is gone, no SIGKILL follows it for a group that ignores it. An
  // exit handler runs nothing after itself, so Windows' taskkill is waited for, as dsh does.
  process.once("exit", () => {
    for (const pid of liveProcessGroups) {
      if (WINDOWS) killTree(pid, { wait: true });
      else signalGroup(pid, "SIGKILL");
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
    // Node starts no .cmd, as npx is on Windows, but through cmd.exe, which cross-spawn quotes for.
    const child = crossSpawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group, so closing the transport can terminate the server's children too.
      detached: !WINDOWS,
      windowsHide: true,
    });
    this.#child = child;
    const pid = child.pid;
    if (pid !== undefined) {
      installExitHook();
      liveProcessGroups.add(pid);
      // Windows finds no tree under a server that has exited, and may give its pid to another.
      if (WINDOWS) child.once("exit", () => liveProcessGroups.delete(pid));
    }
    child.stdout?.on("data", (chunk: Buffer) => this.#lines.readStdout(chunk));
    child.stdout?.on("error", (error) => this.emitError(error));
    child.stdin?.on("error", (error) => {
      if (!this.#closed) this.emitError(error);
    });
    child.stderr?.on("data", (chunk: Buffer) => this.#lines.readStderr(chunk));
    child.stderr?.on("error", (error) => this.emitError(error));
    // Not on "exit": children of the server can outlive it while still holding its pipes.
    child.on("close", () => {
      this.#child = undefined;
      this.#lines.end();
      // Closed or not: a process it left in its group that ignores SIGTERM still needs the SIGKILL.
      if (pid !== undefined) this.#reap(pid);
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
    // On Windows, as in pi, a server that already exited leaves no tree to find: its pipes are let
    // go at once, whoever still holds them.
    if (WINDOWS && (child.exitCode !== null || child.signalCode !== null)) {
      child.stdin?.end();
      for (const stream of [child.stdout, child.stderr]) stream?.destroy();
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
        resolve();
      });
      const grace = Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);
      timers.push(setTimeout(() => killProcessTree(child, "SIGTERM"), grace));
      timers.push(setTimeout(() => killProcessTree(child, "SIGKILL"), grace + closeTimeoutMs));
      // A process that left the group, a daemon the server started, holds its pipes past every
      // kill, and "close" waits for them: they are let go, as a command's are.
      timers.push(
        setTimeout(
          () => {
            for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
            resolve();
          },
          grace + closeTimeoutMs + PIPE_DRAIN_MS,
        ),
      );
      child.stdin?.end();
    });
  }

  /**
   * Ends what a server that exited, closed or on its own, left in its group: processes with pipes
   * of their own, or none, don't hold the transport open and would outlive the task.
   */
  #reap(pid: number): void {
    if (!signalGroup(pid, "SIGTERM")) {
      liveProcessGroups.delete(pid);
      return;
    }
    const closeTimeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    // The exit hook names the group until the SIGKILL has gone.
    setTimeout(() => {
      signalGroup(pid, "SIGKILL");
      liveProcessGroups.delete(pid);
    }, closeTimeoutMs).unref();
  }
}
