// environ.ts, the local entries' first import (boundaries.test.ts holds the order): the local app
// starts on Node and refuses Bun.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { which } from "@eidolon/config";
import { expect, test } from "vitest";

const ENVIRON = join(import.meta.dirname, "../../src/local/environ.ts");

test("it loads on Node", () => {
  const run = spawnSync(process.execPath, [ENVIRON], { encoding: "utf8" });
  expect([run.status, run.stderr]).toEqual([0, ""]);
});

test.skipIf(which("bun") === null)("it exits on Bun, saying how to start the app", () => {
  const run = spawnSync("bun", ["--no-env-file", ENVIRON], { encoding: "utf8" });
  expect([run.status, run.stderr]).toEqual([
    1,
    "eidolon: the local app runs on Node 24 or later: start it with `bun run app` or `node apps/bot/src/local/main.ts`.\n",
  ]);
});
