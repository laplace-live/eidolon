// The job runner in a process of its own, started with an environment a test chose: it runs one
// job of the fake CLI and prints the EIDOLON_NO_DOTENV that job saw. Run as
// `bun --no-env-file jobs-env-child.ts` with EIDOLON_HOME set to the test's data home.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JobRunner } from "../../src/local/jobs/runner.ts";
import { jobFiles } from "../../src/local/jobs/store.ts";

const fakeCli = join(import.meta.dir, "jobs-fake-cli.ts");
const runner = new JobRunner({
  argv: (command, args) => [
    process.execPath,
    "--no-env-file",
    fakeCli,
    "env",
    command,
    "--json",
    ...args,
  ],
});
const job = runner.start({
  command: "refine",
  persona: "milky-green",
  options: {},
  cli: "refine",
  args: ["--persona", "milky-green"],
});
await job.ended;
const [first] = readFileSync(jobFiles(job.record.id).events, "utf8").split("\n");
process.stdout.write(
  `job saw ${JSON.stringify((JSON.parse(first as string) as { message: string }).message)}\n`,
);
