// The eidolon command a task's commands run: the script, and that it runs this checkout's CLI from
// nothing but a command's cut environment.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { eidolonScript, writeEidolonCommand } from "../src/eidolon-command.ts";
import { bashOffered } from "../src/tools/shell.ts";
import { removeTempFolders, tempFolder } from "./tool-folder.ts";

afterEach(removeTempFolders);

const PLACES = {
  runtime: { command: "/opt/node/bin/node", env: {} },
  entry: "/opt/eidolon/dist/cli.js",
  dataHome: "/home/o'neil/.laplace/eidolon",
};

describe("eidolonScript", () => {
  test("the npm package's: its launcher's variables, then the CLI on its Node", () => {
    const env = {
      EIDOLON_APP_ROOT: "/opt/eidolon",
      EIDOLON_NO_DOTENV: "1",
      OPENROUTER_API_KEY: "sk-or-SECRET",
    };
    expect(eidolonScript({ ...PLACES, env })).toBe(
      [
        "#!/bin/sh",
        "# Eidolon's CLI for a task's commands. Eidolon writes this file again each time it starts.",
        "EIDOLON_HOME='/home/o'\\''neil/.laplace/eidolon'; export EIDOLON_HOME",
        "EIDOLON_APP_ROOT='/opt/eidolon'; export EIDOLON_APP_ROOT",
        "EIDOLON_NO_DOTENV='1'; export EIDOLON_NO_DOTENV",
        `exec '/opt/node/bin/node' '/opt/eidolon/dist/cli.js' "$@"`,
        "",
      ].join("\n"),
    );
  });

  test("a checkout's: no launcher variables", () => {
    const script = eidolonScript({ ...PLACES, env: {} });
    expect(script).not.toContain("EIDOLON_APP_ROOT");
    expect(script).not.toContain("EIDOLON_NO_DOTENV");
  });

  test("Electron's: its binary runs the CLI as Node", () => {
    const runtime = {
      command: "/Applications/Eidolon.app/Eidolon",
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const script = eidolonScript({ ...PLACES, runtime, env: {} });
    expect(script).toContain("ELECTRON_RUN_AS_NODE='1'; export ELECTRON_RUN_AS_NODE\n");
    expect(script).toContain(
      `exec '/Applications/Eidolon.app/Eidolon' '/opt/eidolon/dist/cli.js' "$@"`,
    );
  });

  test("on Windows its paths take forward slashes, which Git Bash and Node both read", () => {
    const script = eidolonScript({
      runtime: { command: "C:\\Program Files\\nodejs\\node.exe", env: {} },
      entry: "C:\\npx\\node_modules\\@laplace.live\\eidolon\\dist\\cli.js",
      dataHome: "C:\\Users\\o'neil\\.laplace\\eidolon",
      env: { EIDOLON_APP_ROOT: "C:\\npx\\node_modules\\@laplace.live\\eidolon" },
      platform: "win32",
    });
    expect(script).toContain(
      "EIDOLON_HOME='C:/Users/o'\\''neil/.laplace/eidolon'; export EIDOLON_HOME\n",
    );
    expect(script).toContain(
      "EIDOLON_APP_ROOT='C:/npx/node_modules/@laplace.live/eidolon'; export EIDOLON_APP_ROOT\n",
    );
    expect(script).toContain(
      `exec 'C:/Program Files/nodejs/node.exe' 'C:/npx/node_modules/@laplace.live/eidolon/dist/cli.js' "$@"`,
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
    const run = spawnSync(path, ["prepare-batch", "--help"], {
      cwd: dataHome,
      env: { PATH: "/usr/bin:/bin", HOME: dataHome },
      encoding: "utf8",
    });
    expect([run.status, run.stdout.split("\n")[0]]).toEqual([
      0,
      "usage: laplace-prepare-batch [-h] --expected-count EXPECTED_COUNT",
    ]);
    // Written again over the last.
    expect(await writeEidolonCommand(dataHome)).toBe(path);
  });
});
