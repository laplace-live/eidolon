// `bun apps/cli/src/main.ts <command> [args]`; tests never import it.

// Must stay the first import. ESM evaluates every import before this module's body, so a .env load
// in the body would run after the packages were evaluated.
import "./load-env.ts";
import { logToStderr } from "@eidolon/config";
import { runWithSignals } from "@eidolon/ingest";
import { cleanupLimitMs, runCli } from "./cli.ts";

// Stdout carries only what a command prints, so `--json` output and `| jq` stay clean.
logToStderr();
const argv = Bun.argv.slice(2);
// Not process.exit(): it drops whatever stdout still has queued for a pipe, cutting `| jq` short.
process.exitCode = await runWithSignals(
  (signal) => runCli(argv, { signal }),
  process,
  cleanupLimitMs(argv),
);
