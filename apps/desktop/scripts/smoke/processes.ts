// Every process a desktop smoke starts, by pid, and what those start in turn: the app's main, its
// backend, the backend's jobs, a server the app attaches to. At the end, or on Ctrl-C, whatever
// still runs is stopped by pid, trees included, and a smoke whose processes outlived it fails.
import {
  type ChildProcess,
  execFile,
  execFileSync,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { promisify } from "node:util";
import { killTree } from "@eidolon/config";

const execFileAsync = promisify(execFile);
const GRACE_MS = 5000;

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** Its command line, which tells it from a later process given the same pid. */
  readonly command: string;
}

// Windows PowerShell's own output is UTF-16 unless told otherwise; tabs can't appear in a pid.
const WINDOWS_TABLE =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8\n" +
  "Get-CimInstance Win32_Process | ForEach-Object { " +
  '"$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CommandLine) { $_.CommandLine } else { $_.Name })" }';

function tableCommand(platform: NodeJS.Platform): readonly [string, readonly string[]] {
  if (platform === "win32") {
    const encoded = Buffer.from(WINDOWS_TABLE, "utf16le").toString("base64");
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]];
  }
  return ["ps", ["-axww", "-o", "pid=,ppid=,command="]];
}

/** ps's or PowerShell's lines as rows; a line without two numbers first is skipped. */
export function parseTable(text: string, platform: NodeJS.Platform): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match =
      platform === "win32"
        ? /^(\d+)\t(\d+)\t(.*)$/.exec(line)
        : /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() });
  }
  return rows;
}

/** Every process on the machine. */
export async function processTable(platform: NodeJS.Platform = process.platform) {
  const [command, args] = tableCommand(platform);
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return parseTable(stdout, platform);
}

function processTableSync(platform: NodeJS.Platform = process.platform): ProcessRow[] {
  const [command, args] = tableCommand(platform);
  const stdout = execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return parseTable(stdout, platform);
}

/** Every process under `roots` in `table`, the roots left out, parents before children. */
export function descendants(table: readonly ProcessRow[], roots: Iterable<number>): ProcessRow[] {
  const inside = new Set(roots);
  const found: ProcessRow[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of table) {
      if (inside.has(row.ppid) && !inside.has(row.pid)) {
        inside.add(row.pid);
        found.push(row);
        grew = true;
      }
    }
  }
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Entry {
  readonly what: string;
  readonly pid: number;
  readonly child: ChildProcess | null;
  /** Its command line when first seen; null for a child of this smoke, whose exit is known. */
  readonly command: string | null;
}

/** A process the smoke started, with its exit once it has one. */
export interface Started {
  readonly what: string;
  readonly child: ChildProcess;
  /** Resolves with its exit, or at once when it already exited. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
}

export class Processes {
  readonly #entries = new Map<number, Entry>();
  readonly #platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.#platform = platform;
  }

  /** Starts and tracks `command`, with no console window on Windows. */
  spawn(what: string, command: string, args: readonly string[], options: SpawnOptions): Started {
    const child = spawn(command, args, { windowsHide: true, ...options });
    // A failed start emits error, which with no listener would end the smoke.
    child.on("error", () => {});
    if (child.pid === undefined) throw new Error(`${what} didn't start: ${command}`);
    return this.track(what, child);
  }

  /** Tracks a child something else started for the smoke, such as Playwright's Electron. */
  track(what: string, child: ChildProcess): Started {
    if (child.pid === undefined) throw new Error(`${what} has no pid`);
    this.#entries.set(child.pid, { what, pid: child.pid, child, command: null });
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        done({ code: child.exitCode, signal: child.signalCode });
      } else child.once("exit", (code, signal) => done({ code, signal }));
    });
    return { what, child, exited };
  }

  /** Tracks a process the smoke didn't start, such as the app's backend, while it runs. */
  async adopt(what: string, pid: number): Promise<void> {
    const row = (await processTable(this.#platform)).find((candidate) => candidate.pid === pid);
    if (row !== undefined && !this.#entries.has(pid)) {
      this.#entries.set(pid, { what, pid, child: null, command: row.command });
    }
  }

  /** Tracks every process now running under a tracked one, so its outliving the smoke fails it. */
  async snapshot(): Promise<void> {
    this.#record(await processTable(this.#platform));
  }

  /** Whether `pid` is one the smoke tracks, or runs under one. */
  async ours(pid: number): Promise<boolean> {
    if (this.#entries.has(pid)) return true;
    const table = await processTable(this.#platform);
    return descendants(table, this.#roots(table)).some((row) => row.pid === pid);
  }

  /** Each tracked process still running, as `what (pid N)`, after a fresh look. */
  async running(): Promise<string[]> {
    const table = await processTable(this.#platform);
    this.#record(table);
    return this.#live(table).map((entry) => `${entry.what} (pid ${entry.pid})`);
  }

  /** running(), once it's empty or `ms` have passed: helpers take a moment to follow their main. */
  async settle(ms: number): Promise<string[]> {
    const deadline = Date.now() + ms;
    for (;;) {
      const left = await this.running();
      if (left.length === 0 || Date.now() >= deadline) return left;
      await new Promise((done) => setTimeout(done, 250));
    }
  }

  /**
   * Stops every tracked process still running and what runs under it: SIGTERM, then SIGKILL after
   * 5 s; on Windows taskkill's tree kill, as killTree does.
   */
  async stopAll(): Promise<void> {
    const table = await processTable(this.#platform);
    this.#record(table);
    const targets = this.#live(table);
    if (this.#platform === "win32") {
      for (const entry of treeRoots(table, targets)) killTree(entry.pid, { wait: true });
      return;
    }
    for (const entry of targets) signal(entry.pid, "SIGTERM");
    const deadline = Date.now() + GRACE_MS;
    while (Date.now() < deadline && targets.some((entry) => this.#runs(entry))) {
      await new Promise((done) => setTimeout(done, 100));
    }
    for (const entry of targets) if (this.#runs(entry)) signal(entry.pid, "SIGKILL");
  }

  /** stopAll at once and synchronously, for a signal handler: SIGKILL, or taskkill's tree kill. */
  killAllSync(): void {
    let table: ProcessRow[];
    try {
      table = processTableSync(this.#platform);
    } catch {
      table = [];
    }
    this.#record(table);
    const targets = this.#live(table);
    if (this.#platform === "win32") {
      for (const entry of treeRoots(table, targets)) killTree(entry.pid, { wait: true });
    } else for (const entry of targets) signal(entry.pid, "SIGKILL");
  }

  #roots(table: readonly ProcessRow[]): number[] {
    return this.#live(table).map((entry) => entry.pid);
  }

  #record(table: readonly ProcessRow[]): void {
    for (const row of descendants(table, this.#roots(table))) {
      const parent = this.#entries.get(row.ppid);
      if (!this.#entries.has(row.pid)) {
        this.#entries.set(row.pid, {
          what: `${row.command.slice(0, 160)}, under ${parent?.what ?? "a tracked process"}`,
          pid: row.pid,
          child: null,
          command: row.command,
        });
      }
    }
  }

  /** The tracked entries still running: a child before its exit, else its pid with its command. */
  #live(table: readonly ProcessRow[]): Entry[] {
    const commands = new Map(table.map((row) => [row.pid, row.command]));
    return [...this.#entries.values()].filter((entry) =>
      entry.child !== null
        ? entry.child.exitCode === null && entry.child.signalCode === null && alive(entry.pid)
        : commands.get(entry.pid) === entry.command,
    );
  }

  #runs(entry: Entry): boolean {
    return entry.child !== null
      ? entry.child.exitCode === null && entry.child.signalCode === null
      : alive(entry.pid);
  }
}

/**
 * The entries no other entry is under: taskkill's /T ends the rest with them, and a pid named after
 * its process ended may already be another's.
 */
function treeRoots(table: readonly ProcessRow[], entries: readonly Entry[]): Entry[] {
  const parents = new Map(table.map((row) => [row.pid, row.ppid]));
  const pids = new Set(entries.map((entry) => entry.pid));
  return entries.filter((entry) => !pids.has(parents.get(entry.pid) ?? -1));
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Gone already.
  }
}
