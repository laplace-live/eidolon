// The node shim's launchers (apps/desktop/node-shim): npx's arguments as pnpm dlx's, then each POSIX
// launcher run with this Node as EIDOLON_NODE, as the backend runs them with the app's own binary,
// on the checkout's pnpm and a PATH where only they offer node.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { LAUNCHER_SOURCES, POSIX_LAUNCHERS } from "../scripts/node-shim.ts";

type Translated = { args: string[] } | { error: string };
const { npxToPnpm }: { npxToPnpm(args: readonly string[]): Translated } = await import(
  pathToFileURL(join(LAUNCHER_SOURCES, "npx.mjs")).href
);

describe("npx's arguments, as pnpm dlx's", () => {
  const dlx = (...rest: string[]) => ({ args: ["--loglevel=error", "dlx", ...rest] });

  test("leave out -y, --yes, -q and --quiet, and pass on the package and every word after it", () => {
    expect(npxToPnpm(["-y", "@modelcontextprotocol/server-filesystem", "/tmp", "-y"])).toEqual(
      dlx("--", "@modelcontextprotocol/server-filesystem", "/tmp", "-y"),
    );
    expect(npxToPnpm(["--yes", "-q", "--quiet", "server@1.2.3", "--port=1", "-c", "--"])).toEqual(
      dlx("--", "server@1.2.3", "--port=1", "-c", "--"),
    );
  });

  test("give each package as --package=, in order, then the command", () => {
    expect(npxToPnpm(["-p", "a", "--package", "b@2", "--package=@c/d", "-y", "run", "-x"])).toEqual(
      dlx("--package=a", "--package=b@2", "--package=@c/d", "--", "run", "-x"),
    );
  });

  test("after --, take the next word as the package, whatever it starts with", () => {
    expect(npxToPnpm(["-y", "--", "-odd", "--", "x"])).toEqual(dlx("--", "-odd", "--", "x"));
  });

  test("refuse an option they don't map, a package option with no package, and nothing to run", () => {
    for (const [args, error] of [
      [["-c", "echo hi"], "-c can't be passed on to pnpm dlx"],
      [["--call=echo $TOKEN"], "--call can't be passed on to pnpm dlx"],
      [["-yq", "server"], "-yq can't be passed on to pnpm dlx"],
      [["--registry=https://example.test", "server"], "--registry can't be passed on to pnpm dlx"],
      [["-y", "-p"], "-p needs a package"],
      [["--package=", "server"], "--package needs a package"],
      [[], "nothing to run"],
      [["-y", "--"], "nothing to run"],
      [["--package", "a"], "nothing to run"],
    ] as const) {
      expect([args, npxToPnpm(args)]).toEqual([args, { error }]);
    }
  });
});

describe.skipIf(process.platform === "win32")("the launchers, on this Node", () => {
  const scratch = mkdtempSync(join(tmpdir(), "eidolon-node-shim-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const home = join(scratch, "home");
  mkdirSync(home);
  // A package whose command prints what it was given.
  const pkg = join(scratch, "hello");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "eidolon-shim-hello", version: "1.0.0", bin: "bin/hello.js" }),
  );
  writeFileSync(
    join(pkg, "bin", "hello.js"),
    "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
  );
  chmodSync(join(pkg, "bin", "hello.js"), 0o755);

  /** A launcher, run with pnpm's store and caches in `scratch`. */
  function run(
    name: string,
    args: readonly string[],
    env: Record<string, string> = { EIDOLON_NODE: process.execPath },
  ): SpawnSyncReturns<string> {
    return spawnSync(join(LAUNCHER_SOURCES, name), args, {
      cwd: scratch,
      encoding: "utf8",
      timeout: 60_000,
      env: { HOME: home, PATH: `/usr/bin:/bin:${LAUNCHER_SOURCES}`, ...env },
    });
  }

  test("npx runs a package's command through the bundled pnpm, the command's output alone on stdout", () => {
    const ran = run("npx", ["-y", `file:${pkg}`, "--flag", "value"]);
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    expect(JSON.parse(ran.stdout)).toEqual(["--flag", "value"]);
  });

  test("an npx that fails says why on stderr, and prints nothing on stdout", () => {
    const ran = run("npx", ["-y", `file:${join(scratch, "missing")}`]);
    expect([ran.status, ran.stdout]).toEqual([1, ""]);
    expect(ran.stderr).toContain("ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND");
  });

  test("an npx option it doesn't map ends it, with the reason", () => {
    const ran = run("npx", ["-c", "echo hi"]);
    expect([ran.status, ran.stdout, ran.stderr]).toEqual([
      1,
      "",
      "npx: -c can't be passed on to pnpm dlx\n",
    ]);
  });

  test("node, pnpm and pnpx run on EIDOLON_NODE, pnpm at apps/desktop's pin", () => {
    const { devDependencies } = JSON.parse(
      readFileSync(join(LAUNCHER_SOURCES, "..", "package.json"), "utf8"),
    );
    expect(run("node", ["-p", "process.execPath"]).stdout).toBe(`${process.execPath}\n`);
    expect(run("pnpm", ["--version"]).stdout).toBe(`${devDependencies.pnpm}\n`);
    expect(JSON.parse(run("pnpx", [`file:${pkg}`, "x"]).stdout)).toEqual(["x"]);
  });

  test("each refuses to run without EIDOLON_NODE", () => {
    for (const name of POSIX_LAUNCHERS) {
      const ran = run(name, ["--version"], {});
      expect([name, ran.status, ran.stdout, ran.stderr]).toEqual([
        name,
        1,
        "",
        `${name}: EIDOLON_NODE isn't set: Eidolon sets it for the MCP servers it starts\n`,
      ]);
    }
  });
});
