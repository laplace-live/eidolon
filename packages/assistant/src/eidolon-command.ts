// The `eidolon` a task's commands find first on their PATH, in the data home's bin folder beside
// the managed yt-dlp: a shell script that runs this install's CLI on the app's own runtime, with its
// data home, whatever the command's cut environment holds. The app writes it again at each start.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { binDir, cliEntry, jsRuntime } from "@eidolon/config";
import { replaceFile } from "./transcript.ts";

/** The npm package's own files and its no-.env rule, which its launcher sets for the app. */
const CARRIED = ["EIDOLON_APP_ROOT", "EIDOLON_NO_DOTENV"] as const;

export interface EidolonScript {
  /** What runs the CLI: the app's own runtime (jsRuntime). */
  readonly runtime: ReturnType<typeof jsRuntime>;
  /** The CLI's entry (cliEntry). */
  readonly entry: string;
  readonly dataHome: string;
  /** The app's environment, whose CARRIED variables the CLI gets too. */
  readonly env: NodeJS.ProcessEnv;
  /** This process's when omitted. */
  readonly platform?: NodeJS.Platform;
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The script, in POSIX sh; on Windows, for Git Bash, its paths with forward slashes. */
export function eidolonScript(options: EidolonScript): string {
  const { env, runtime } = options;
  const windows = (options.platform ?? process.platform) === "win32";
  const sh = (value: string) => quoted(windows ? value.replaceAll("\\", "/") : value);
  const variables: [string, string][] = [
    ["EIDOLON_HOME", options.dataHome],
    ...Object.entries(runtime.env),
    ...CARRIED.flatMap((name): [string, string][] => {
      const value = env[name];
      return value ? [[name, value]] : [];
    }),
  ];
  return [
    "#!/bin/sh",
    "# Eidolon's CLI for a task's commands. Eidolon writes this file again each time it starts.",
    ...variables.map(([name, value]) => `${name}=${sh(value)}; export ${name}`),
    `exec ${[runtime.command, ...runtime.args, options.entry].map(sh).join(" ")} "$@"`,
    "",
  ].join("\n");
}

/**
 * Writes `<dataHome>/bin/eidolon` whole, readable and runnable by this user only, for this
 * process's runtime, CLI and environment; resolves to its path.
 */
export async function writeEidolonCommand(dataHome: string): Promise<string> {
  const bin = binDir(dataHome);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const path = join(bin, "eidolon");
  const script = eidolonScript({
    runtime: jsRuntime(),
    entry: cliEntry(),
    dataHome,
    env: process.env,
  });
  await replaceFile(path, script, 0o700);
  return path;
}
