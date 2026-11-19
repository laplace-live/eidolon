// The eidolon command a task's commands run: the script, and that it runs this checkout's CLI from
// nothing but a command's cut environment.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eidolonScript, writeEidolonCommand } from "../src/eidolon-command.ts";
import { bashOffered } from "../src/tools/shell.ts";
import { removeTempFolders, tempFolder } from "./tool-folder.ts";

afterEach(removeTempFolders);

const PLACES = {
  bun: "/opt/bun/bin/bun",
  entry: "/opt/eidolon/dist/cli.js",
  bunfig: "/opt/eidolon/bunfig.toml",
  dataHome: "/home/o'neil/.laplace/eidolon",
};

describe("eidolonScript", () => {
  test("the npm package's: its launcher's variables, then the CLI on its Bun", () => {
    const env = {
      EIDOLON_APP_ROOT: "/opt/eidolon",
      EIDOLON_NO_DOTENV: "1",
      BUN_OPTIONS: '"--config=/opt/eidolon/bunfig.toml" --smol',
      OPENROUTER_API_KEY: "sk-or-SECRET",
    };
    expect(eidolonScript({ ...PLACES, env })).toBe(
      [
        "#!/bin/sh",
        "# Eidolon's CLI for a task's commands. Eidolon writes this file again each time it starts.",
        "EIDOLON_HOME='/home/o'\\''neil/.laplace/eidolon'; export EIDOLON_HOME",
        `BUN_OPTIONS='"--config=/opt/eidolon/bunfig.toml" --smol'; export BUN_OPTIONS`,
        "EIDOLON_APP_ROOT='/opt/eidolon'; export EIDOLON_APP_ROOT",
        "EIDOLON_NO_DOTENV='1'; export EIDOLON_NO_DOTENV",
        `exec '/opt/bun/bin/bun' --no-env-file '/opt/eidolon/dist/cli.js' "$@"`,
        "",
      ].join("\n"),
    );
  });

  test("a checkout's: its own bunfig.toml, never the one in the folder a command runs in", () => {
    const script = eidolonScript({ ...PLACES, env: {} });
    expect(script).toContain(
      `BUN_OPTIONS='"--config=/opt/eidolon/bunfig.toml"'; export BUN_OPTIONS\n`,
    );
    expect(script).not.toContain("EIDOLON_APP_ROOT");
    expect(script).not.toContain("EIDOLON_NO_DOTENV");
    // The owner's own BUN_OPTIONS come after it, as the npm launcher puts them.
    expect(eidolonScript({ ...PLACES, env: { BUN_OPTIONS: "--smol" } })).toContain(
      `BUN_OPTIONS='"--config=/opt/eidolon/bunfig.toml" --smol'; export BUN_OPTIONS\n`,
    );
  });
});

describe.skipIf(!bashOffered())("writeEidolonCommand", () => {
  test("writes bin/eidolon for this user alone, and it runs the CLI on a bare PATH", async () => {
    const dataHome = await tempFolder();
    const path = await writeEidolonCommand(dataHome);
    expect(path).toBe(join(dataHome, "bin", "eidolon"));
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toContain(`EIDOLON_HOME='${dataHome}'; export EIDOLON_HOME`);
    const run = Bun.spawnSync([path, "prepare-batch", "--help"], {
      cwd: dataHome,
      env: { PATH: "/usr/bin:/bin", HOME: dataHome },
    });
    expect([run.exitCode, run.stdout.toString().split("\n")[0]]).toEqual([
      0,
      "usage: laplace-prepare-batch [-h] --expected-count EXPECTED_COUNT",
    ]);
    // Written again over the last.
    expect(await writeEidolonCommand(dataHome)).toBe(path);
  });
});
