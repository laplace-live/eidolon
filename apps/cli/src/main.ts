// `bun apps/cli/src/main.ts <command> [args]`; tests never import it.

// Must stay the first import. ESM evaluates every import before this module's body, so a .env load
// in the body would run after the packages were evaluated.
import "./load-env.ts";
import { runWithSignals } from "@eidolon/ingest";
import { withUsageScope } from "@eidolon/providers";
import { installUsageLedger } from "@eidolon/usage";
import { cleanupLimitMs, runCli } from "./cli.ts";

const argv = Bun.argv.slice(2);
installUsageLedger();
// A job the local app started carries its id, which its usage records name.
const job = process.env.EIDOLON_JOB_ID;
// Not process.exit(): it drops whatever stdout still has queued for a pipe, cutting `| jq` short.
process.exitCode = await withUsageScope({ source: "job", ...(job ? { session: job } : {}) }, () =>
  runWithSignals((signal) => runCli(argv, { signal }), process, cleanupLimitMs(argv)),
);
