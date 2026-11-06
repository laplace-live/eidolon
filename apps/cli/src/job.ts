// How the web app runs a command as a job: this CLI as a child process, reporting NDJSON. Keep this
// module import-free: the web app imports it (`@eidolon/cli/job`) without Bun or Node modules.

/**
 * The argv of a job running `command` through the CLI at `entry` (@eidolon/config's cliEntry): no
 * .env from the job's working directory (load-env.ts reads the repository's), and progress events
 * on stdout.
 */
export function jobArgv(entry: string, command: string, args: readonly string[]): string[] {
  return [process.execPath, "--no-env-file", entry, command, "--json", ...args];
}
