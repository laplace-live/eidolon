// The npm package's `eidolon` command, which npx runs on Node: it finds the Bun the package ships
// for this platform and runs the web app's supervisor or the CLI on it.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The platforms LanceDB's and onnxruntime-node's binaries cover, with Bun's and LanceDB's builds. */
export const PLATFORMS = {
  "darwin-arm64": { bun: "@oven/bun-darwin-aarch64", lancedb: "@lancedb/lancedb-darwin-arm64" },
  "linux-x64": { bun: "@oven/bun-linux-x64", lancedb: "@lancedb/lancedb-linux-x64-gnu" },
  "linux-arm64": { bun: "@oven/bun-linux-aarch64", lancedb: "@lancedb/lancedb-linux-arm64-gnu" },
} as const;

export type Platform = keyof typeof PLATFORMS;

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
}

const SUPPORTED =
  "Eidolon runs on macOS on Apple silicon, and on Linux with glibc on x64 or arm64.";

/** Why the native modules can't run on `host`, or null when they can. */
export function unsupportedReason(host: Host): string | null {
  const key = `${host.platform}-${host.arch}`;
  if (host.platform === "darwin" && host.arch === "x64") {
    return host.rosetta
      ? "this Node is an x64 build that Rosetta translates, and Eidolon's native modules are " +
          "arm64. Install the arm64 build of Node, then run eidolon again."
      : `Intel Macs are not supported: LanceDB and onnxruntime-node ship no build for them. ${SUPPORTED}`;
  }
  if (!Object.hasOwn(PLATFORMS, key)) {
    return `${key} is not supported: LanceDB and onnxruntime-node ship no build for it. ${SUPPORTED}`;
  }
  if (host.platform === "linux" && !host.glibc) {
    return (
      "Linux with musl, such as Alpine, is not supported: onnxruntime-node ships glibc builds " +
      "only. Use a glibc distribution, such as Debian or Ubuntu."
    );
  }
  return null;
}

export interface BunLookup {
  /** `require.resolve` from the launcher; null when nothing resolves. */
  resolve(specifier: string): string | null;
  /** A file's size in bytes; null when it is missing. */
  size(path: string): number | null;
  /** The `version` of the package.json at `path`. */
  version(path: string): string | null;
}

// bun's own bin/bun.exe is a shell script of a few hundred bytes until its postinstall replaces it.
const PLACEHOLDER_MAX_BYTES = 64 * 1024;

/** The Bun to run on `platform`: `version`, the one this package depends on. */
export function findBun(platform: Platform, version: string, lookup: BunLookup): string | null {
  const own = lookup.resolve(`${PLATFORMS[platform].bun}/bin/bun`);
  if (own !== null) return own;
  // In a project that also depends on bun at this version, bun's postinstall moved the binary
  // above into its own bin/bun.exe.
  const bun = lookup.resolve("bun/package.json");
  if (bun === null || lookup.version(bun) !== version) return null;
  const exe = join(dirname(bun), "bin", "bun.exe");
  return (lookup.size(exe) ?? 0) > PLACEHOLDER_MAX_BYTES ? exe : null;
}

function bunMissing(platform: Platform, version: string): string {
  return (
    `the Bun runtime for ${platform} (${PLATFORMS[platform].bun}@${version}) is not installed. ` +
    "It is an optional dependency: install again without --omit=optional or --no-optional, or " +
    `set EIDOLON_BUN to a Bun ${version} binary.`
  );
}

/** The environment of the Bun this runs: the package's files, and no .env or cwd bunfig.toml. */
export function childEnv(env: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  // Bun reads bunfig.toml from the working directory, which is the user's; BUN_OPTIONS replaces it
  // in every Bun the app starts, jobs included. Bun honors quotes only around the first option, so
  // the package's leads: a path with a space survives.
  const config = `"--config=${join(root, "bunfig.toml")}"`;
  return {
    ...env,
    EIDOLON_APP_ROOT: root,
    EIDOLON_NO_DOTENV: "1",
    BUN_OPTIONS: env.BUN_OPTIONS ? `${config} ${env.BUN_OPTIONS}` : config,
  };
}

function currentHost(): Host {
  const { platform, arch } = process;
  // On musl, Node's and Bun's reports leave glibcVersionRuntime out.
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
  return { platform, arch, glibc, rosetta };
}

function systemLookup(): BunLookup {
  const require = createRequire(import.meta.url);
  return {
    resolve(specifier) {
      try {
        return require.resolve(specifier);
      } catch {
        return null;
      }
    },
    size(path) {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    },
    version(path) {
      try {
        const { version } = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
        return typeof version === "string" ? version : null;
      } catch {
        return null;
      }
    },
  };
}

function fail(message: string, code = 1): void {
  process.stderr.write(`eidolon: ${message}\n`);
  process.exitCode = code;
}

/** Runs Bun until it exits, then exits as it did. */
function run(bun: string, argv: readonly string[], env: NodeJS.ProcessEnv): void {
  const child = spawn(bun, argv, { stdio: "inherit", env });
  // A terminal's Ctrl-C reaches the child itself, in this process group. Passing it on as well
  // would be a second SIGINT, which makes a CLI command quit without finishing an index.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  // The app and the CLI stop gracefully on SIGTERM; neither handles SIGHUP.
  process.on("SIGHUP", () => child.kill("SIGTERM"));
  child.on("error", (error) => {
    fail(`could not start ${bun}: ${error.message}`);
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
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
    optionalDependencies: Record<string, string>;
  };
  const command = parseCommand(argv);
  switch (command.kind) {
    case "help":
      process.stdout.write(usage(manifest.version));
      return;
    case "version":
      process.stdout.write(`${manifest.version}\n`);
      return;
    case "unknown":
      fail(`unknown command ${JSON.stringify(command.name)}\n\n${usage(manifest.version)}`, 2);
      return;
  }
  const host = currentHost();
  const reason = unsupportedReason(host);
  if (reason !== null) {
    fail(reason);
    return;
  }
  const platform = `${host.platform}-${host.arch}` as Platform;
  const version = manifest.optionalDependencies[PLATFORMS[platform].bun] ?? "";
  const bun = process.env.EIDOLON_BUN || findBun(platform, version, systemLookup());
  if (bun === null) {
    fail(bunMissing(platform, version));
    return;
  }
  run(
    bun,
    ["--no-env-file", join(root, ENTRIES[command.kind]), ...command.args],
    childEnv(process.env, root),
  );
}
