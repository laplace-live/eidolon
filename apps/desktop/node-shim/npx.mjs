// npx for an MCP server where the computer has none: npx's arguments as pnpm dlx's, run by the pnpm
// Eidolon bundles in this process. pnpm reports dlx on stderr, so the server's stdout, which the MCP
// protocol owns, holds only what the server prints.
import { fileURLToPath } from "node:url";

const DROPPED = new Set(["-y", "--yes", "-q", "--quiet"]);

/**
 * npx's arguments as pnpm's: `--loglevel=error dlx`, each package npx was given as `--package=X`,
 * then `--` and the first other word, the package or with `--package` the command, with every word
 * after it as it came. An option this doesn't map is an error, named without its value.
 * @param {readonly string[]} args
 * @returns {{ args: string[] } | { error: string }}
 */
export function npxToPnpm(args) {
  const packages = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (DROPPED.has(arg)) continue;
    const option = arg.split("=", 1)[0];
    if (option === "-p" || option === "--package") {
      const name = option === arg ? args[++at] : arg.slice(option.length + 1);
      if (!name) return { error: `${option} needs a package` };
      packages.push(`--package=${name}`);
      continue;
    }
    if (arg !== "--" && arg.startsWith("-")) {
      return { error: `${option} can't be passed on to pnpm dlx` };
    }
    const command = args.slice(arg === "--" ? at + 1 : at);
    if (command.length === 0) break;
    return { args: ["--loglevel=error", "dlx", ...packages, "--", ...command] };
  }
  return { error: "nothing to run" };
}

if (import.meta.main) {
  const translated = npxToPnpm(process.argv.slice(2));
  if ("error" in translated) {
    console.error(`npx: ${translated.error}`);
    process.exit(1);
  }
  const pnpm = new URL("../node_modules/pnpm/bin/pnpm.mjs", import.meta.url);
  process.argv = [process.execPath, fileURLToPath(pnpm), ...translated.args];
  await import(pnpm.href);
}
