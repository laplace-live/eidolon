// The npm package's `eidolon` command, which npx runs on Node: it runs the web app's supervisor or
// the CLI on that same Node.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The platforms Eidolon runs on, each with Zvec's prebuilt binding for it. */
export const PLATFORMS = {
  "darwin-arm64": "@zvec/bindings-darwin-arm64",
  "linux-x64": "@zvec/bindings-linux-x64",
  "linux-arm64": "@zvec/bindings-linux-arm64",
  "win32-x64": "@zvec/bindings-win32-x64",
} as const;

/**
 * The Visual C++ runtime's DLLs that onnxruntime-node's Windows build imports, and Windows doesn't
 * ship. Missing, it fails to load with "The specified module could not be found".
 */
export const VC_RUNTIME_DLLS: readonly string[] = [
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_atomic_wait.dll",
];

/** The oldest Node major that runs the bundles, which the package's `engines` names too. */
export const NODE_MAJOR = 24;

/** The CLI's commands, but gate-decisions, which reads and writes the repository's benchmarks. */
export const CLI_COMMANDS: readonly string[] = [
  "pipeline",
  "download",
  "transcribe",
  "refine",
  "ingest-streams",
  "ingest-facts",
  "build-stream-catalog",
  "search",
  "eval-retrieval",
  "generate-image",
  "extract-users",
  "prepare-batch",
  "discover",
  "task",
];

/** Each entry's bundle, relative to the package. */
export const ENTRIES = { app: "dist/app.js", cli: "dist/cli.js" } as const;

export type Command =
  | { readonly kind: "app" | "cli"; readonly args: readonly string[] }
  | { readonly kind: "help" | "version" }
  | { readonly kind: "unknown"; readonly name: string };

/** No arguments, `app` or a flag runs the web app; a CLI command's name runs the CLI. */
export function parseCommand(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "app", args: [] };
  if (first === "app") return { kind: "app", args: rest };
  if (first === "-h" || first === "--help") return { kind: "help" };
  if (first === "--version") return { kind: "version" };
  if (first.startsWith("-")) return { kind: "app", args: argv };
  if (CLI_COMMANDS.includes(first)) return { kind: "cli", args: argv };
  return { kind: "unknown", name: first };
}

export function usage(version: string): string {
  return `usage: eidolon [app] [--host HOST] [--port PORT] [-v] [--open | --no-open]
       eidolon <command> [args]

Eidolon ${version}. With no command, or app, runs the web app on this computer and opens it in a
browser (eidolon app --help for its flags). Settings and keys are kept in ~/.laplace/eidolon, or
the folder EIDOLON_HOME names; no .env file is read.

commands, each with --help:
${wrap(CLI_COMMANDS, 98, "  ")}
`;
}

function wrap(words: readonly string[], width: number, indent: string): string {
  const lines: string[] = [];
  let line = indent;
  for (const word of words) {
    if (line.length > indent.length && line.length + 2 + word.length > width) {
      lines.push(line);
      line = indent;
    }
    line += line.length > indent.length ? `  ${word}` : word;
  }
  return [...lines, line].join("\n");
}

export interface Host {
  readonly platform: string;
  readonly arch: string;
  /** On Linux, whether the C library is glibc. */
  readonly glibc: boolean;
  /** On macOS, whether this is an x64 process Rosetta translates. */
  readonly rosetta: boolean;
  /** On Windows, whether the Visual C++ runtime the native modules load is installed. */
  readonly vcRuntime: boolean;
}

const SUPPORTED =
  "Eidolon runs on macOS on Apple silicon, on Linux with glibc on x64 or arm64, and on Windows " +
  "on x64.";

/** Why the native modules can't run on `host`, or null when they can. */
export function unsupportedReason(host: Host): string | null {
  const key = `${host.platform}-${host.arch}`;
  if (host.platform === "darwin" && host.arch === "x64") {
    return host.rosetta
      ? "this Node is an x64 build that Rosetta translates, and Eidolon's native modules are " +
          "arm64. Install the arm64 build of Node, then run eidolon again."
      : `Intel Macs are not supported: onnxruntime-node ships no build for them. ${SUPPORTED}`;
  }
  if (host.platform === "win32" && host.arch === "arm64") {
    return (
      "this Node is an arm64 build, and Eidolon's native modules for Windows are x64. Install " +
      "the x64 build of Node, which Windows on Arm runs too, then run eidolon again."
    );
  }
  if (!Object.hasOwn(PLATFORMS, key)) {
    return `${key} is not supported: Zvec and onnxruntime-node ship no build for it. ${SUPPORTED}`;
  }
  if (host.platform === "win32" && !host.vcRuntime) {
    return (
      "the Microsoft Visual C++ Redistributable, which onnxruntime-node needs, is " +
      "missing or out of date. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe, " +
      "then run eidolon again."
    );
  }
  if (host.platform === "linux" && !host.glibc) {
    return (
      "Linux with musl, such as Alpine, is not supported: onnxruntime-node ships glibc builds " +
      "only. Use a glibc distribution, such as Debian or Ubuntu."
    );
  }
  return null;
}

/** Why Node `version` (process.versions.node) can't run the bundles, or null when it can. */
export function unsupportedNode(version: string): string | null {
  if (Number.parseInt(version, 10) >= NODE_MAJOR) return null;
  return (
    `this is Node.js ${version}, and Eidolon needs Node.js ${NODE_MAJOR} or later. Install a ` +
    "newer Node, then run eidolon again."
  );
}

/** The app's environment: the package's files, and no .env. */
export function childEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  return { ...env, EIDOLON_APP_ROOT: root, EIDOLON_NO_DOTENV: "1" };
}

function currentHost(): Host {
  const { platform, arch } = process;
  // On musl, Node's report leaves glibcVersionRuntime out.
  const report =
    platform === "linux"
      ? (process.report.getReport() as { header: { glibcVersionRuntime?: string } })
      : null;
  const glibc = Boolean(report?.header.glibcVersionRuntime);
  const rosetta =
    platform === "darwin" &&
    arch === "x64" &&
    spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" }).stdout?.trim() ===
      "1";
  return { platform, arch, glibc, rosetta, vcRuntime: platform !== "win32" || hasVcRuntime() };
}

/** Whether every VC_RUNTIME_DLLS is where Windows looks for a DLL: System32, else a PATH folder. */
export function hasVcRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  const folders = [
    join(env.SystemRoot ?? "C:\\Windows", "System32"),
    ...(env.PATH ?? "").split(";"),
  ];
  return VC_RUNTIME_DLLS.every((dll) =>
    folders.some((folder) => folder !== "" && existsSync(join(folder, dll))),
  );
}

function fail(message: string, code = 1): void {
  process.stderr.write(`eidolon: ${message}\n`);
  process.exitCode = code;
}

/** Runs `bundle` on this Node until it exits, then exits as it did. */
function run(bundle: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [bundle, ...args], { stdio: "inherit", env });
  // A terminal's Ctrl-C reaches the child itself, in this process group: passing it on would
  // deliver it twice.
  process.on("SIGINT", () => {});
  if (process.platform === "win32") {
    // Closing the console window reaches the child too, and kill() there is TerminateProcess.
    process.on("SIGHUP", () => {});
  } else {
    process.on("SIGTERM", () => child.kill("SIGTERM"));
    // As SIGTERM: the CLI has no SIGHUP handler, so a SIGHUP would end it at once.
    process.on("SIGHUP", () => child.kill("SIGTERM"));
  }
  child.on("error", (error) => {
    fail(`could not start ${process.execPath}: ${error.message}`);
    process.exit();
  });
  child.on("exit", (code, signal) => {
    if (signal === null) process.exit(code ?? 1);
    // Ended by a signal: end by it too, so the shell sees what the child saw.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    process.exit(128 + (constants.signals[signal] ?? 0));
  });
}

export function main(argv: readonly string[]): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const command = parseCommand(argv);
  switch (command.kind) {
    case "help":
      process.stdout.write(usage(version));
      return;
    case "version":
      process.stdout.write(`${version}\n`);
      return;
    case "unknown":
      fail(`unknown command ${JSON.stringify(command.name)}\n\n${usage(version)}`, 2);
      return;
  }
  const reason = unsupportedReason(currentHost()) ?? unsupportedNode(process.versions.node);
  if (reason !== null) {
    fail(reason);
    return;
  }
  run(join(root, ENTRIES[command.kind]), command.args, childEnv(process.env, root));
}
