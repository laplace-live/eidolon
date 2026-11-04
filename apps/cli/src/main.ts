// `bun apps/cli/src/main.ts <command> [args]`; tests never import it.

// Must stay the first import. ESM evaluates every import before this module's body, so a .env load
// in the body would run after the packages were evaluated.
import "./load-env.ts";
import { runCli } from "./cli.ts";

// Not process.exit(): it drops whatever stdout still has queued for a pipe, cutting `| jq` short.
process.exitCode = await runCli(Bun.argv.slice(2));
