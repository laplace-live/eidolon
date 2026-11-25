// A child process as the code drives it, over node:child_process: its exit as a promise, its output
// as web streams.
import { type Serializable, type StdioOptions, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { Readable, type Writable } from "node:stream";
import { which } from "./which.ts";

export type StdioTarget = "ignore" | "pipe" | "inherit" | number; // a number is an open fd

export interface SpawnOptions {
  readonly cwd?: string;
  /** The child's whole environment; omitted, it inherits process.env. */
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: "ignore" | "pipe" | "inherit"; // default "ignore"
  readonly stdout?: StdioTarget; // default "pipe"
  readonly stderr?: StdioTarget; // default "inherit"
  /**
   * setsid(): its own session and process group, so killing -pid reaches what it started. On
   * Windows: no console, and it outlives this process, which otherwise takes it along.
   */
  readonly detached?: boolean;
  /** SIGTERM once this many ms have passed. */
  readonly timeout?: number;
  /** Opens a JSON IPC channel; each message the child sends arrives here. */
  readonly ipc?: (message: unknown) => void;
}

export interface Subprocess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly stdin: Writable | null;
  /** Resolves once it has exited: its exit code, or 128 + the signal's number. Never rejects. */
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): void;
  send(message: unknown): void; // only with `ipc`
  unref(): void;
}

/**
 * The error Node emits a tick after a failed start, named by what most likely failed: ENOENT for a
 * missing program or working folder, EACCES for a path that is no executable file.
 */
function startError(command: string, args: readonly string[], options: SpawnOptions): Error {
  const cwd = options.cwd ?? process.cwd();
  const direct = command.includes("/") || (process.platform === "win32" && command.includes("\\"));
  const path = direct ? resolve(cwd, command) : null;
  let code = "UNKNOWN";
  // A cwd that is no folder throws ENOTDIR from spawn itself, so only a missing one gets here.
  if (!existsSync(cwd)) code = "ENOENT";
  else if (path !== null) {
    if (which(path) === null) code = existsSync(path) ? "EACCES" : "ENOENT";
  } else if (which(command, options.env?.PATH ?? process.env.PATH ?? "") === null) {
    code = "ENOENT";
  }
  const errno = (constants.errno as Readonly<Record<string, number | undefined>>)[code];
  return Object.assign(new Error(`spawn ${command} ${code}`), {
    code,
    ...(errno === undefined ? {} : { errno: -errno }),
    syscall: `spawn ${command}`,
    path: command,
    spawnargs: [...args],
  });
}

function webStream(stream: Readable | null): ReadableStream<Uint8Array> | null {
  // node:stream/web's ReadableStream is the global one at runtime; only the declarations differ.
  return stream === null ? null : (Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>);
}

/** Throws at once when the program can't start, which Node reports a tick later. */
export function spawnProcess(
  argv: readonly [string, ...string[]],
  options: SpawnOptions = {},
): Subprocess {
  const [command, ...args] = argv;
  const stdio: StdioOptions = [
    options.stdin ?? "ignore",
    options.stdout ?? "pipe",
    options.stderr ?? "inherit",
  ];
  const { ipc } = options;
  if (ipc !== undefined) stdio.push("ipc");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio,
    detached: options.detached ?? false,
    // A console program started by a process with no console, as a job's yt-dlp is on Windows,
    // opens a window of its own.
    windowsHide: true,
    serialization: "json",
    timeout: options.timeout,
  });
  // A failed start and a failed kill emit "error", which with no listener would end this process:
  // the first throws below, and the second goes unreported.
  child.on("error", () => {});
  if (child.pid === undefined) throw startError(command, args, options);
  if (ipc !== undefined) child.on("message", (message) => ipc(message));
  const exited = new Promise<number>((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
    });
  });
  return {
    pid: child.pid,
    stdout: webStream(child.stdout),
    stderr: webStream(child.stderr),
    stdin: child.stdin,
    exited,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill(signal) {
      child.kill(signal);
    },
    send(message) {
      if (ipc === undefined) throw new Error("send() needs a process spawned with ipc");
      child.send(message as Serializable, () => {});
    },
    unref() {
      child.unref();
    },
  };
}

/**
 * Kills process `pid` and what it started: its process group, which a child spawned detached
 * leads, else the process alone; on Windows, which has no groups, its tree, through taskkill, as pi
 * does. Call it only while `pid` runs: Windows reuses a pid once its process is gone. `wait`, as an
 * exit handler needs, returns only once taskkill has.
 */
export function killTree(pid: number, options: { readonly wait?: boolean } = {}): void {
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const args = ["/F", "/T", "/PID", String(pid)];
    if (options.wait) spawnSync(taskkill, args, { stdio: "ignore", windowsHide: true });
    else {
      // Outside this process's job, which would end taskkill with this process.
      spawn(taskkill, args, { stdio: "ignore", detached: true, windowsHide: true }).on(
        "error",
        () => {},
      );
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
