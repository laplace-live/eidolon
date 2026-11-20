// How the web app runs a command as a job: this CLI as a child process, reporting NDJSON. Keep this
// module import-free: the web app imports it (`@eidolon/cli/job`) without Node's modules.

/**
 * The argv of a job running `command` through the CLI at `entry` (@eidolon/config's cliEntry), with
 * progress events on stdout.
 */
export function jobArgv(entry: string, command: string, args: readonly string[]): string[] {
  return [process.execPath, entry, command, "--json", ...args];
}
