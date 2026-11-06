// The install check's own plumbing: waiting on the app it stops leaves nothing to hold it open.
import { expect, test } from "bun:test";
import { join } from "node:path";

test("a wait on a child that exits leaves no timer to keep the script running", () => {
  const script = join(import.meta.dir, "../scripts/ci-install-check.ts");
  const started = performance.now();
  const run = Bun.spawnSync([
    process.execPath,
    "--no-env-file",
    "-e",
    `const { exitWithin } = await import(${JSON.stringify(script)});
     console.log(await exitWithin(Bun.spawn(["true"]), 5_000));`,
  ]);
  expect([run.exitCode, run.stdout.toString(), run.stderr.toString()]).toEqual([0, "0\n", ""]);
  expect(performance.now() - started).toBeLessThan(2_500);
}, 15_000);
