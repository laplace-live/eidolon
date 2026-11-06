// load-env.ts run in a process of its own, as a copy in a temporary app with a .env of the test's:
// the walk up from the copy finds that .env first, so a developer's own never reaches a test.
import "../../../packages/config/test/isolated-guard.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, findDotenv } from "@eidolon/config";

let app = "";

beforeAll(() => {
  app = mkdtempSync(join(tmpdir(), "eidolon-cli-load-env-"));
  mkdirSync(join(app, "src"));
  for (const file of ["load-env.ts", "persona-arg.ts"]) {
    writeFileSync(join(app, "src", file), readFileSync(join(import.meta.dir, "..", "src", file)));
  }
  writeFileSync(
    join(app, "src", "probe.ts"),
    'import "./load-env.ts";\nconsole.log("probe=" + (process.env.EIDOLON_DOTENV_PROBE ?? "unset"));\n',
  );
  writeFileSync(join(app, ".env"), "EIDOLON_DOTENV_PROBE=from-dotenv\n");
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(app, "node_modules"));
});

afterAll(() => {
  // The link first, so the removal can't reach the real node_modules through it.
  unlinkSync(join(app, "node_modules"));
  rmSync(app, { recursive: true, force: true });
});

async function probe(env: Record<string, string>): Promise<string | undefined> {
  expect(findDotenv(join(app, "src"))).toBe(join(app, ".env"));
  const child = Bun.spawn([process.execPath, "--no-env-file", join(app, "src", "probe.ts")], {
    cwd: app,
    env: { PATH: process.env.PATH ?? "", EIDOLON_HOME: dataHome(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  expect(code).toBe(0);
  return /^probe=(.*)$/m.exec(out)?.[1];
}

test("load-env.ts applies the .env it finds above it, over the environment", async () => {
  expect(await probe({})).toBe("from-dotenv");
  expect(await probe({ EIDOLON_DOTENV_PROBE: "from-env" })).toBe("from-dotenv");
});

test("EIDOLON_NO_DOTENV=1 skips the .env: the process environment is all there is", async () => {
  expect(await probe({ EIDOLON_NO_DOTENV: "1" })).toBe("unset");
  expect(await probe({ EIDOLON_NO_DOTENV: "1", EIDOLON_DOTENV_PROBE: "from-env" })).toBe(
    "from-env",
  );
});
