// The node shim's POSIX launchers (apps/desktop/node-shim), each run with this Node as
// EIDOLON_NODE, as the backend runs them with the app's own binary, on the checkout's pnpm and a
// PATH where only they offer node: npx running a local bin as npm's does, and installing from a
// registry served here as npm would. npx's decisions themselves are npx.test.ts's.
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { LAUNCHER_SOURCES, POSIX_LAUNCHERS } from "../scripts/node-shim.ts";

const POSIX = process.platform !== "win32";

/** Writes `files` under `base`, executable. */
function write(base: string, files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    const file = join(base, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    chmodSync(file, 0o755);
  }
  return base;
}

describe.skipIf(!POSIX)("the launchers, on this Node", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "eidolon-node-shim-")));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const home = join(scratch, "home");
  mkdirSync(home);
  // A package whose command prints what it was given.
  const pkg = write(join(scratch, "hello"), {
    "package.json": JSON.stringify({
      name: "eidolon-shim-hello",
      version: "1.0.0",
      bin: "bin/hello.js",
    }),
    "bin/hello.js": "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
  });
  // A project with a bin of its own in node_modules/.bin, run from a folder below it.
  const project = write(join(scratch, "project"), {
    "package.json": JSON.stringify({ name: "eidolon-shim-project", version: "1.0.0" }),
    "node_modules/.bin/eidolon-shim-local": [
      "#!/bin/sh",
      `printf '%s\\n' "$(pwd)" "\${PATH%%:*}" "\${ELECTRON_RUN_AS_NODE-unset}"`,
      'for a in "$@"; do printf "[%s]\\n" "$a"; done',
      'if [ -n "$KILL" ]; then kill -TERM $$; fi',
      "exit $((EXIT + 0))",
      "",
    ].join("\n"),
  });
  const below = join(project, "sub", "dir");
  mkdirSync(below, { recursive: true });

  /** A launcher, run from `cwd` with pnpm's store and caches in `scratch`. */
  function run(
    name: string,
    args: readonly string[],
    env: Record<string, string> = { EIDOLON_NODE: process.execPath },
    cwd = scratch,
  ): SpawnSyncReturns<string> {
    return spawnSync(join(LAUNCHER_SOURCES, name), args, {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: { HOME: home, PATH: `/usr/bin:/bin:${LAUNCHER_SOURCES}`, ...env },
    });
  }

  test("npx runs a folder's command, linked as npm links it, its output alone on stdout", () => {
    const ran = run("npx", ["-y", `file:${pkg}`, "--flag", "value"]);
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    expect(JSON.parse(ran.stdout)).toEqual(["--flag", "value"]);
  });

  test("npx runs a bin in a node_modules/.bin above the folder, never a registry's", () => {
    const args = ["a b", "", 'q"x', "$HOME", "*", "-y"];
    const ran = run("npx", ["eidolon-shim-local", ...args], undefined, below);
    expect([ran.status, ran.stderr]).toEqual([0, ""]);
    expect(ran.stdout.split("\n")).toEqual([
      below,
      join(project, "node_modules", ".bin"),
      "unset",
      ...args.map((arg) => `[${arg}]`),
      "",
    ]);
  });

  test("npx ends as the command did, on its exit code or its signal", () => {
    const exited = run(
      "npx",
      ["eidolon-shim-local"],
      { EIDOLON_NODE: process.execPath, EXIT: "3" },
      below,
    );
    expect(exited.status).toBe(3);
    const killed = run(
      "npx",
      ["eidolon-shim-local"],
      { EIDOLON_NODE: process.execPath, KILL: "1" },
      below,
    );
    expect([killed.status, killed.signal]).toEqual([null, "SIGTERM"]);
  });

  test("an npx that fails says why on stderr, and prints nothing on stdout", () => {
    const ran = run("npx", ["-y", `file:${join(scratch, "missing")}`]);
    expect([ran.status, ran.stdout]).toEqual([254, ""]);
    expect(ran.stderr).toMatch(/^npx: could not read package\.json: ENOENT/);
  });

  test("an npx option it doesn't take ends it, with the reason", () => {
    const ran = run("npx", ["-c", "echo hi"]);
    expect([ran.status, ran.stdout, ran.stderr]).toEqual([
      1,
      "",
      "npx: Eidolon's npx doesn't take -c\n",
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

/** Packs `dir` as npm does, as package/ in a gzipped tarball, with the registry's integrity. */
function pack(dir: string, out: string): { file: string; integrity: string; shasum: string } {
  const stage = mkdtempSync(join(tmpdir(), "eidolon-pack-"));
  spawnSync("cp", ["-R", dir, join(stage, "package")]);
  spawnSync("tar", ["-czf", out, "-C", stage, "package"]);
  rmSync(stage, { recursive: true, force: true });
  const data = readFileSync(out);
  return {
    file: out,
    integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`,
    shasum: createHash("sha1").update(data).digest("hex"),
  };
}

describe.skipIf(!POSIX)("npx from a registry, against one served here", () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "eidolon-npx-registry-")));
  const files = new Map<string, string>();
  const packuments = new Map<string, object>();
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? "/");
    const file = files.get(url);
    const packument = packuments.get(url.slice(1));
    response.writeHead(file || packument ? 200 : 404);
    response.end(file ? readFileSync(file) : JSON.stringify(packument ?? { error: "Not found" }));
  });
  afterAll(() => {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * Publishes the package in `dir` at `time`, or with `time` undefined serves it at a URL pnpm
   * doesn't take for its registry's, which it would ask for the package's metadata.
   */
  function publish(registry: string, dir: string, time?: string): string {
    const { name, version, ...rest } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const urlPath =
      time === undefined ? `/plain/${name}-${version}.tgz` : `/${name}/-/${name}-${version}.tgz`;
    const packed = pack(dir, join(scratch, `${name}-${version}.tgz`));
    files.set(urlPath, packed.file);
    if (time === undefined) return `${registry}${urlPath}`;
    const packument = (packuments.get(name) ?? { name, versions: {}, time: {} }) as {
      versions: Record<string, object>;
      time: Record<string, string>;
      "dist-tags"?: object;
    };
    packument.versions[version] = {
      name,
      version,
      ...rest,
      dist: {
        tarball: `${registry}${urlPath}`,
        integrity: packed.integrity,
        shasum: packed.shasum,
      },
    };
    packument.time[version] = time;
    packument["dist-tags"] = { latest: version };
    packuments.set(name, packument);
    return `${registry}${urlPath}`;
  }

  test("installs the newest, a dependency by URL with its postinstall, and runs it", async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const old = "2020-01-01T00:00:00.000Z";
    const markers = join(scratch, "markers");
    mkdirSync(markers);
    publish(
      registry,
      write(join(scratch, "leaf"), {
        "package.json": JSON.stringify({ name: "eidolon-test-leaf", version: "1.0.0" }),
        "index.js": 'module.exports = "leaf";\n',
      }),
      old,
    );
    // Its postinstall prints, and npx's stdout must not show it.
    const dep = publish(
      registry,
      write(join(scratch, "dep"), {
        "package.json": JSON.stringify({
          name: "eidolon-test-dep",
          version: "1.0.0",
          dependencies: { "eidolon-test-leaf": "1.0.0" },
          scripts: { postinstall: "node post.js" },
        }),
        "post.js": [
          'console.log("postinstall");',
          `require("fs").writeFileSync(${JSON.stringify(join(markers, "dep"))}, "");`,
          "",
        ].join("\n"),
        "index.js": 'module.exports = "dep";\n',
      }),
    );
    for (const [version, time] of [
      ["1.0.0", old],
      ["1.1.0", new Date().toISOString()],
    ] as const) {
      publish(
        registry,
        write(join(scratch, `app-${version}`), {
          "package.json": JSON.stringify({
            name: "eidolon-test-app",
            version,
            type: "module",
            bin: { "eidolon-test-app": "cli.mjs" },
            dependencies: { "eidolon-test-dep": dep },
          }),
          // eidolon-test-leaf is its dependency's, which npm hoists beside it.
          "cli.mjs": [
            "#!/usr/bin/env node",
            'import dep from "eidolon-test-dep";',
            'import leaf from "eidolon-test-leaf";',
            `const version = "${version}";`,
            "console.log(JSON.stringify({ version, dep, leaf, args: process.argv.slice(2) }));",
            "",
          ].join("\n"),
        }),
        time,
      );
    }
    const home = join(scratch, "home");
    mkdirSync(home);
    /** npx, with pnpm's store and caches in `home`; spawnSync would hold the registry up. */
    const npx = async (args: readonly string[]) => {
      const child = spawn(join(LAUNCHER_SOURCES, "npx"), args, {
        cwd: scratch,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${LAUNCHER_SOURCES}`,
          EIDOLON_NODE: process.execPath,
          pnpm_config_registry: `${registry}/`,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const status = await new Promise((resolve) => child.on("close", resolve));
      return { status, stdout, stderr };
    };
    expect(await npx(["-y", "eidolon-test-app", "x"])).toEqual({
      status: 0,
      stdout: `${JSON.stringify({ version: "1.1.0", dep: "dep", leaf: "leaf", args: ["x"] })}\n`,
      stderr: "",
    });
    expect(existsSync(join(markers, "dep"))).toBe(true);
    const missing = await npx(["-y", "eidolon-test-missing"]);
    expect([missing.status, missing.stdout]).toEqual([1, ""]);
    expect(missing.stderr).toContain("ERR_PNPM_FETCH_404");
  }, 60_000);
});
