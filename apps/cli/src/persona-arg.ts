// Keep this module import-free: load-env.ts evaluates it before the .env is applied.

const FLAG = "--persona";

/**
 * The persona `--persona <id>` or `--persona=<id>` names, the last one before a bare `--`.
 * load-env.ts installs it before any setting is read, which argparse would do too late for.
 */
export function personaArg(argv: readonly string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") break;
    if (arg.startsWith(`${FLAG}=`)) {
      found = arg.slice(FLAG.length + 1);
    } else if (arg === FLAG) {
      const value = argv[i + 1];
      // argparse reads a following "-x" as an option, and then fails on the missing value.
      if (value !== undefined && !value.startsWith("-")) {
        found = value;
        i++;
      }
    }
  }
  return found || undefined;
}
