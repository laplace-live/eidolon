// What only the packaged smoke (scripts/smoke.ts) reads of a packaged app and its processes, and how
// it runs the app's launchers as a terminal would. Paths and command lines follow the platform
// passed in, so Windows' rules are tested on any OS.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { dirname, join, posix, win32 } from "node:path";
import { promisify } from "node:util";
import { BACKEND_RUNTIME_ARGS } from "../../src/main/controller.ts";
import { type ProcessRow, parseTable, processTable } from "./processes.ts";

const execFileAsync = promisify(execFile);

/** Where a packaged app's parts are, from its binary. */
export interface AppLayout {
  readonly binary: string;
  /** process.resourcesPath: Contents/Resources, or resources beside Eidolon.exe. */
  readonly resources: string;
  /** The staged backend. */
  readonly payload: string;
  /** What main loads for the tray, and on macOS the About panel. */
  readonly trayIcon: string;
  /** The eidolon command's launcher, which Settings links or puts on the PATH. */
  readonly terminalCommand: string;
  /** The node shim's launchers, which MCP servers get last on their PATH. */
  readonly nodeShim: string;
}

export function appLayout(binary: string, platform: NodeJS.Platform = process.platform): AppLayout {
  const path = platform === "win32" ? win32 : posix;
  const resources =
    platform === "win32"
      ? path.join(path.dirname(binary), "resources")
      : path.join(path.dirname(path.dirname(binary)), "Resources");
  const payload = path.join(resources, "eidolon");
  return {
    binary,
    resources,
    payload,
    trayIcon: path.join(resources, "assets", "tray-icon.ico"),
    terminalCommand: path.join(resources, "bin", platform === "win32" ? "eidolon.cmd" : "eidolon"),
    nodeShim: path.join(payload, "node-shim", "node_modules", ".bin"),
  };
}

/** How to run a launcher with `args`, as a terminal would. */
export interface ScriptRun {
  readonly command: string;
  readonly args: readonly string[];
  /** Windows: the command line is cmd.exe's own, quoted as it reads it. */
  readonly windowsVerbatimArguments: boolean;
}

/**
 * A launcher `script` run with `args`: itself, by its #! line, on macOS; on Windows a .cmd through
 * cmd.exe, each argument in quotes, as a terminal runs it. An argument holding a quote, or ending
 * in a backslash, which escapes its closing quote, can't be passed this way.
 */
export function scriptRun(
  script: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec = "cmd.exe",
): ScriptRun {
  if (platform !== "win32") return { command: script, args, windowsVerbatimArguments: false };
  // /s strips the outer quotes, leaving the line inside as typed.
  const line = [script, ...args].map((arg) => `"${arg}"`).join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/** The OS's own folders, which a PATH with no node of the computer's holds. */
export function systemFolders(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform !== "win32") return ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const root = env.SystemRoot ?? "C:\\Windows";
  return [
    win32.join(root, "System32"),
    root,
    win32.join(root, "System32", "Wbem"),
    win32.join(root, "System32", "WindowsPowerShell", "v1.0"),
  ];
}

/**
 * `env` with `values` in place of the variables they name; on Windows found without case, since a
 * name spelled twice there runs with either value (Windows' own PATH is often `Path`).
 */
export function withVariables(
  env: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const key = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
  const replaced = new Set(Object.keys(values).map(key));
  const kept = Object.entries(env).filter(([name]) => !replaced.has(key(name)));
  return { ...Object.fromEntries(kept), ...values };
}

/** Each node in `folders` that a shell would run for `node`. */
export function nodesIn(
  folders: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const path = platform === "win32" ? win32 : posix;
  const names = platform === "win32" ? ["node.exe", "node.cmd", "node.bat"] : ["node"];
  return folders.flatMap((folder) =>
    names.map((name) => path.join(folder, name)).filter((file) => existsSync(file)),
  );
}

/** A loopback port nothing listens on, where a request fails at once. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/**
 * A stand-in for EIDOLON_NODE in `folder` that prints the ELECTRON_RUN_AS_NODE it got. A launcher
 * that ran the app's binary without it would start Eidolon itself on the installed app's profile,
 * where an Eidolon already running would come forward.
 */
export function runAsNodeProbe(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const probe = join(folder, "run-as-node.cmd");
    writeFileSync(probe, "@echo off\r\necho %ELECTRON_RUN_AS_NODE%\r\n");
    return probe;
  }
  const probe = join(folder, "run-as-node");
  writeFileSync(probe, '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE"\n', { mode: 0o755 });
  return probe;
}

/**
 * What a failed run's stderr says went wrong: the line Node gives an uncaught error, else its first
 * error line, else its last line.
 */
export function cause(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  // Node prints an uncaught error below the line that threw it, which can name an error too, and a
  // caret under that, and ends with its own version, which says nothing.
  const caret = lines.findIndex((line) => /^\^+$/.test(line));
  const thrown = caret === -1 ? undefined : lines[caret + 1];
  return thrown ?? lines.find((line) => /error\b|\bERR_/i.test(line)) ?? lines.at(-1) ?? "";
}

/** A Windows command line's arguments, split as the C runtime splits them. */
export function windowsArgs(line: string): string[] {
  const args: string[] = [];
  let arg: string | null = null;
  let quoted = false;
  let slashes = 0;
  for (const char of line) {
    if (char === "\\") {
      slashes++;
      continue;
    }
    if (char === '"') {
      // 2n backslashes and a quote are n backslashes and a toggle; 2n + 1, n and a literal quote.
      arg = (arg ?? "") + "\\".repeat(slashes >> 1);
      if (slashes % 2 === 1) arg += '"';
      else quoted = !quoted;
      slashes = 0;
      continue;
    }
    if (slashes > 0) {
      arg = (arg ?? "") + "\\".repeat(slashes);
      slashes = 0;
    }
    if ((char === " " || char === "\t") && !quoted) {
      if (arg !== null) args.push(arg);
      arg = null;
      continue;
    }
    arg = (arg ?? "") + char;
  }
  if (slashes > 0) arg = (arg ?? "") + "\\".repeat(slashes);
  if (arg !== null) args.push(arg);
  return args;
}

/**
 * Whether `command`, a process's command line, runs `script` on `binary` in node mode as main runs
 * the backend: its runtime arguments first.
 */
export function runsOnBinary(
  command: string,
  binary: string,
  script: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const expected = [binary, ...BACKEND_RUNTIME_ARGS, script];
  if (platform === "win32") {
    const args = windowsArgs(command);
    return expected.every((part, i) => args[i]?.toLowerCase() === part.toLowerCase());
  }
  // ps joins the arguments with spaces, unquoted.
  const head = expected.join(" ");
  return command === head || command.startsWith(`${head} `);
}

/** Whether `path` is inside `folder`; on Windows without case, and without `\\?\`. */
export function inside(
  path: string,
  folder: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const plain = (value: string) => {
    const resolved = paths.resolve(value.replace(/^\\\\\?\\/, ""));
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const relative = paths.relative(plain(folder), plain(path));
  const up = relative === ".." || relative.startsWith(`..${paths.sep}`);
  return relative !== "" && !up && !paths.isAbsolute(relative);
}

/** The natives and the runtime libraries they import, by file name. */
export const NATIVE = /onnxruntime|zvec|sharp|vips|vcruntime140|msvcp140/i;

/** The .node and .dylib files in `lsof -p`'s answer, by path. */
export function lsofLibraries(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    const at = line.indexOf(" /");
    const path = at === -1 ? "" : line.slice(at + 1).trimEnd();
    return /\.(node|dylib)$/.test(path) ? [path] : [];
  });
}

/** PowerShell's pipeline for the natives a process has loaded, by path. */
export function modulesScript(pid: number): string {
  return `(Get-Process -Id ${pid}).Modules | Where-Object { $_.ModuleName -match '${NATIVE.source}' } | Select-Object FileName`;
}

/** The natives `pid` has mapped, by path: lsof's on macOS, the process's modules on Windows. */
export async function mappedNatives(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  if (platform === "win32") {
    const modules = await powershellJson<{ readonly FileName?: string }>(modulesScript(pid));
    return modules.flatMap((module) => (module.FileName ? [module.FileName] : []));
  }
  const { stdout } = await execFileAsync("lsof", ["-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return lsofLibraries(stdout).filter((path) => NATIVE.test(posix.basename(path)));
}

/** ConvertTo-Json's answer as a list: it gives one object bare, and nothing for none. */
export function jsonList<T>(text: string): T[] {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") return [];
  const value: unknown = JSON.parse(trimmed);
  return (Array.isArray(value) ? value : [value]) as T[];
}

/** The command that runs `script`, one pipeline, with its output as JSON, sent encoded. */
export function powershellCommand(script: string): readonly [string, readonly string[]] {
  // Redirected, PowerShell writes progress records to stderr as CLIXML.
  const text = `$ProgressPreference = "SilentlyContinue"\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script} | ConvertTo-Json -Compress -Depth 4`;
  const encoded = Buffer.from(text, "utf16le").toString("base64");
  return [
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
  ];
}

/** Runs a PowerShell pipeline and reads what it prints as a JSON list. */
export async function powershellJson<T>(script: string): Promise<T[]> {
  const [command, args] = powershellCommand(script);
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return jsonList<T>(stdout);
}

/** A JPEG's size and whether it carries EXIF, from its markers; null when it isn't one. */
export function jpegFacts(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number; readonly exif: boolean } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let exif = false;
  for (let at = 2; at + 4 <= bytes.byteLength && bytes[at] === 0xff; ) {
    const marker = bytes[at + 1] as number;
    const length = view.getUint16(at + 2);
    const exifHeader = String.fromCharCode(...bytes.subarray(at + 4, at + 10));
    if (marker === 0xe1 && exifHeader === "Exif\0\0") exif = true;
    // Every start-of-frame marker but DHT, JPG and DAC.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      height = view.getUint16(at + 5);
      width = view.getUint16(at + 7);
    }
    if (marker === 0xda) break;
    at += 2 + length;
  }
  return width > 0 && height > 0 ? { width, height, exif } : null;
}

/** How many images an .ico holds by its header; 0 when it isn't one. */
export function icoImages(bytes: Uint8Array): number {
  if (bytes.byteLength < 6) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  const icon = view.getUint16(0, true) === 0 && view.getUint16(2, true) === 1;
  return icon && count > 0 && bytes.byteLength >= 6 + 16 * count ? count : 0;
}

/** Every file under `dir` by its path from there, with `/`, as its size and SHA-256; null if none. */
export function fileHashes(dir: string): Readonly<Record<string, string>> | null {
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const hashes: Record<string, string> = {};
  const walk = (folder: string, prefix: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path, `${name}/`);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        hashes[name] = `${bytes.byteLength} ${createHash("sha256").update(bytes).digest("hex")}`;
      }
    }
  };
  walk(dir, "");
  return hashes;
}

/** A file of random bytes placed in a folder, and what takes it away again. */
export interface Marker {
  readonly folder: string;
  /** Deletes the marker, then each folder placeMarker made, deepest first, that holds nothing. */
  remove(): void;
}

/** Writes `name` into `folder`, making the folder and its parents as needed. */
export function placeMarker(folder: string, name: string): Marker {
  const made: string[] = [];
  for (let at = folder; !existsSync(at) && dirname(at) !== at; at = dirname(at)) made.unshift(at);
  for (const at of made) mkdirSync(at, { mode: 0o700 });
  const path = join(folder, name);
  writeFileSync(path, randomBytes(16).toString("hex"), { flag: "wx", mode: 0o600 });
  return {
    folder,
    remove() {
      rmSync(path, { force: true });
      for (const at of [...made].reverse()) {
        try {
          rmdirSync(at);
        } catch {
          // Something else wrote in it since: what isn't the smoke's stays.
          return;
        }
      }
    },
  };
}

/** What differs between two of fileHashes' answers, by path: changed, added or gone. */
export function changedFiles(
  before: Readonly<Record<string, string>> | null,
  after: Readonly<Record<string, string>> | null,
): string[] {
  if ((before === null) !== (after === null)) {
    return [`the folder ${before === null ? "appeared" : "is gone"}`];
  }
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...names].filter((name) => before?.[name] !== after?.[name]).sort();
}

/**
 * On macOS, every process but this one whose command line or environment holds `text`, as rows
 * without the environment: whatever the app started inherits the run's homes, even once
 * reparented. ps shows no environment of Apple's own binaries, such as /bin/sh, which this finds
 * only by their command lines. Elsewhere, none.
 */
export async function processesNaming(
  text: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessRow[]> {
  if (platform !== "darwin") return [];
  const [{ stdout }, plain] = await Promise.all([
    execFileAsync("ps", ["-axwwE", "-o", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
    processTable(platform),
  ]);
  const naming = new Set(
    parseTable(stdout, platform)
      .filter((row) => row.command.includes(text))
      .map((row) => row.pid),
  );
  return plain.filter((row) => naming.has(row.pid) && row.pid !== process.pid);
}

/**
 * backend.log's lines that open a JavaScript error outside the backend's logger format: what
 * console.error printed past it, Node's report of an uncaught error or rejection, or the stack
 * under one of the logger's own ERROR lines.
 */
export function strayErrorLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) =>
      /^\[[^\]]+\] \[?(?:\w*Error\b|Uncaught\b|UnhandledPromiseRejection\b|node:internal\/)/.test(
        line,
      ),
    );
}

/** Where `text`, a log, gives away a link code's line or `token`, by line, never the value. */
export function leaks(text: string, token: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) => [
      ...(/Eidolon is (ready|already running):/.test(line)
        ? [`line ${index + 1} holds a link code's line`]
        : []),
      ...(line.includes(token) ? [`line ${index + 1} holds the token`] : []),
    ]);
}

/** `[2026-11-21 12:16:20.083]` at the start of an electron-log line, as epoch ms; null if none. */
export function lineTime(line: string): number | null {
  const stamp = /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3})\]/.exec(line);
  return stamp === null ? null : new Date(`${stamp[1]}T${stamp[2]}`).getTime();
}

/** A 4×2 JPEG with EXIF orientation 6, as base64: the backend must send it on upright, 2×4, and bare. */
export const ROTATED_PHOTO =
  "/9j/4QDORXhpZgAASUkqAAgAAAAHAA8BAgAGAAAAcgAAABIBAwABAAAABgAAABoBBQABAAAAYgAAABsBBQABAAAAagAAACgB" +
  "AwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAeAAAAAAAAAA4YwAA6AMAADhjAADoAwAAc3Bpa2UABgAAkAcABAAAADAy" +
  "MTABkQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAAQAAAADoAQAAQAAAAIAAAAAAAAA/+IB8ElD" +
  "Q19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAA" +
  "AAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAK" +
  "ZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAU" +
  "YlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAI" +
  "AAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMy" +
  "AAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKW" +
  "AAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAGBAUGBQQG" +
  "BgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoT" +
  "KBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8AAEQgAAgAEAwEiAAIRAQMR" +
  "Af/EABUAAQEAAAAAAAAAAAAAAAAAAAAG/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABUBAQEAAAAAAAAAAAAAAAAAAAUH/8QA" +
  "FBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AigACtv/Z";
