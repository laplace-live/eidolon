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
  writeFileSync(
    join(app, "src", "settings.ts"),
    [
      'import "./load-env.ts";',
      'import { envEntries, envOptional } from "@eidolon/config";',
      "const scan = new Map(envEntries());",
      'console.log("settings=" + JSON.stringify({',
      '  voice: envOptional("TTS_VOICE_ID") ?? envOptional("FISH_VOICE_ID") ?? null,',
      '  gentle: envOptional("FISH_VOICE_ID_GENTLE") ?? null,',
      '  scanned: scan.get("FISH_VOICE_ID_GENTLE") ?? null,',
      '  refine: envOptional("REFINE_MODEL") ?? null,',
      "}));",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(app, ".env"),
    "EIDOLON_DOTENV_PROBE=from-dotenv\nFISH_VOICE_ID=dotenv-voice\nFISH_VOICE_ID_GENTLE=dotenv-gentle\n",
  );
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(app, "node_modules"));
});

afterAll(() => {
  // The link first, so the removal can't reach the real node_modules through it.
  unlinkSync(join(app, "node_modules"));
  rmSync(app, { recursive: true, force: true });
});

async function run(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ out: string; err: string }> {
  expect(findDotenv(join(app, "src"))).toBe(join(app, ".env"));
  const child = Bun.spawn([process.execPath, "--no-env-file", join(app, "src", script), ...args], {
    cwd: app,
    env: { PATH: process.env.PATH ?? "", EIDOLON_HOME: dataHome(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  return { out, err };
}

async function probe(env: Record<string, string>): Promise<string | undefined> {
  return /^probe=(.*)$/m.exec((await run("probe.ts", [], env)).out)?.[1];
}

/** What the bot would read, from stdout alone, which holds nothing else; and the log. */
async function settingsOf(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ settings: unknown; log: string }> {
  const { out, err } = await run("settings.ts", args, env);
  expect(out).toStartWith("settings=");
  expect(out.trimEnd().split("\n")).toHaveLength(1);
  return { settings: JSON.parse(out.slice("settings=".length)), log: err };
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

test("--persona installs her settings: her own file over the .env and the environment", async () => {
  const personas = join(dataHome(), "personas");
  mkdirSync(join(personas, "alice"), { recursive: true });
  mkdirSync(join(personas, "bob"), { recursive: true });
  writeFileSync(
    join(personas, "alice", "persona.yaml"),
    "voice:\n  voiceId: alice-voice\nrefine:\n  model: alice/refiner\n",
  );
  try {
    const env = { REFINE_MODEL: "env/refiner" };
    const alice = await settingsOf(["--persona", "alice"], env);
    expect(alice.settings).toEqual({
      voice: "alice-voice",
      gentle: null,
      scanned: null,
      refine: "alice/refiner",
    });
    expect(alice.log).toContain(
      "FISH_VOICE_ID from the environment is ignored: persona alice sets voice.voiceId",
    );
    expect(alice.log).not.toContain("dotenv-voice");
    const bob = await settingsOf(["--persona=bob"], env);
    expect(bob.settings).toEqual({
      voice: "dotenv-voice",
      gentle: "dotenv-gentle",
      scanned: "dotenv-gentle",
      refine: "env/refiner",
    });
    expect(bob.log).not.toContain("is ignored");
  } finally {
    rmSync(join(personas, "alice"), { recursive: true, force: true });
    rmSync(join(personas, "bob"), { recursive: true, force: true });
  }
});
