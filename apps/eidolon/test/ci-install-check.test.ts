// The install check's own plumbing: waiting on the app it stops leaves nothing to hold it open.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

test("a wait on a child that exits leaves no timer to keep the script running", () => {
  const script = join(import.meta.dirname, "../scripts/ci-install-check.ts");
  const started = performance.now();
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { exitWithin } = await import(${JSON.stringify(script)});
       const { spawnProcess } = await import("@eidolon/config");
       console.log(await exitWithin(spawnProcess(["true"]), 5_000));`,
    ],
    // Where @eidolon/config resolves.
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
  );
  expect([run.status, run.stdout, run.stderr]).toEqual([0, "0\n", ""]);
  expect(performance.now() - started).toBeLessThan(2_500);
}, 15_000);
