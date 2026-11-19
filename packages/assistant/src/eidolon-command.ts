// The `eidolon` a task's commands find first on their PATH, in the data home's bin folder beside
// the managed yt-dlp: a shell script that runs this install's CLI on its Bun, with its data home,
// whatever the command's cut environment holds. The app writes it again at each start.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { binDir, cliEntry, shippedPath } from "@eidolon/config";
import { replaceFile } from "./transcript.ts";

/** The npm package's own files and its no-.env rule, which its launcher sets for the app. */
const CARRIED = ["EIDOLON_APP_ROOT", "EIDOLON_NO_DOTENV"] as const;

export interface EidolonScript {
  /** The Bun that runs the CLI: the app's own. */
  readonly bun: string;
  /** The CLI's entry (cliEntry). */
  readonly entry: string;
  /** The bunfig.toml the CLI's Bun reads in place of one in the folder a command runs in. */
  readonly bunfig: string;
  readonly dataHome: string;
  /** The app's environment, whose CARRIED variables and BUN_OPTIONS the CLI gets too. */
  readonly env: NodeJS.ProcessEnv;
}

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The script, in POSIX sh. */
export function eidolonScript(options: EidolonScript): string {
  const { env } = options;
  // Bun reads a bunfig.toml in the working directory, the task's folder, which could preload code
  // into the CLI; BUN_OPTIONS names the app's, ahead of the owner's own options, as the npm
  // launcher puts it (and has already, there). Bun honors quotes around the first option only.
  const config = `"--config=${options.bunfig}"`;
  const bunOptions = env.BUN_OPTIONS?.startsWith(config)
    ? env.BUN_OPTIONS
    : [config, env.BUN_OPTIONS].filter(Boolean).join(" ");
  const variables: [string, string][] = [
    ["EIDOLON_HOME", options.dataHome],
    ["BUN_OPTIONS", bunOptions],
    ...CARRIED.flatMap((name): [string, string][] => {
      const value = env[name];
      return value ? [[name, value]] : [];
    }),
  ];
  return [
    "#!/bin/sh",
    "# Eidolon's CLI for a task's commands. Eidolon writes this file again each time it starts.",
    ...variables.map(([name, value]) => `${name}=${quoted(value)}; export ${name}`),
    `exec ${quoted(options.bun)} --no-env-file ${quoted(options.entry)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Writes `<dataHome>/bin/eidolon` whole, readable and runnable by this user only, for this
 * process's Bun, CLI and environment; resolves to its path.
 */
export async function writeEidolonCommand(dataHome: string): Promise<string> {
  const bin = binDir(dataHome);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const path = join(bin, "eidolon");
  const script = eidolonScript({
    bun: process.execPath,
    entry: cliEntry(),
    bunfig: shippedPath("bunfig.toml", "bunfig.toml"),
    dataHome,
    env: process.env,
  });
  await replaceFile(path, script, 0o700);
  return path;
}
