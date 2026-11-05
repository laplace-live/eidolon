// main.ts without its .env load, for tests that run the CLI in a process of its own, to send it real
// signals: a developer's .env must never reach a test. Run as `bun --no-env-file cli_child.ts …`.
import { installSettings, logToStderr } from "@eidolon/config";
import { runWithSignals } from "@eidolon/ingest";
import { cleanupLimitMs, runCli } from "../src/cli.ts";
import { personaArg } from "../src/persona-arg.ts";

const argv = Bun.argv.slice(2);
const persona = personaArg(argv);
if (persona) process.env.EIDOLON_PERSONA = persona;
installSettings();
logToStderr();
process.exitCode = await runWithSignals(
  (signal) => runCli(argv, { signal }),
  process,
  cleanupLimitMs(argv),
);
