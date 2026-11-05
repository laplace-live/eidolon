// How the web app runs a command as a job: this CLI as a child process, reporting NDJSON. Keep this
// module import-free: the web app imports it (`@eidolon/cli/job`) without Bun or Node modules.

/** The CLI's entry point. */
export const CLI_ENTRY = `${import.meta.dirname}/main.ts`;

/**
 * The argv of a job running `command`: no .env from the job's working directory (load-env.ts
 * reads the repository's), and progress events on stdout.
 */
export function jobArgv(command: string, args: readonly string[]): string[] {
  return [process.execPath, "--no-env-file", CLI_ENTRY, command, "--json", ...args];
}
