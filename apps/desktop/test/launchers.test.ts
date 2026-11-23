// The node shim's POSIX launchers (apps/desktop/node-shim), each run with this Node as
// EIDOLON_NODE, as the backend runs them with the app's own binary, on the checkout's pnpm and a
// PATH where only they offer node: npx running a local bin as npm's does, and installing from a
// registry served here as npm would. npx's decisions themselves are npx.test.ts's.
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { LAUNCHER_SOURCES, POSIX_LAUNCHERS } from "../scripts/node-shim.ts";
import { BACKEND_RUNTIME_ARGS } from "../src/main/controller.ts";

const POSIX = process.platform !== "win32";

test("each launcher, sh and .cmd, runs EIDOLON_NODE with the backend's runtime flags first", () => {
  for (const file of [...POSIX_LAUNCHERS, ...POSIX_LAUNCHERS.map((name) => `${name}.cmd`)]) {
    const text = readFileSync(join(LAUNCHER_SOURCES, file), "utf8");
    const words = (/^(?:exec )?"(?:\$EIDOLON_NODE|%EIDOLON_NODE%)" (.*)$/m.exec(text)?.[1] ?? "")
      .trimEnd()
      .split(" ");
    const end = words.findIndex((word) => !word.startsWith("-"));
    expect([file, end === -1 ? words : words.slice(0, end)]).toEqual([
      file,
      [...BACKEND_RUNTIME_ARGS],
    ]);
  }
});

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
    // A script with no #! line, which only sh runs.
    "node_modules/.bin/eidolon-shim-plain": `printf 'plain %s\\n' "$@"\nexit 4\n`,
    "node_modules/.bin/eidolon-shim-locked": "#!/bin/sh\necho locked\n",
    "node_modules/.bin/eidolon-shim-trap": [
      "#!/bin/sh",
      "trap 'echo got-TERM; exit 7' TERM",
      "trap 'echo got-INT; exit 8' INT",
      "echo ready",
      "while :; do sleep 0.1; done",
      "",
    ].join("\n"),
  });
  chmodSync(join(project, "node_modules", ".bin", "eidolon-shim-locked"), 0o644);
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

  test("npx runs a tarball a relative path names, from the folder it names it from", () => {
    const folder = join(scratch, "tarball");
    mkdirSync(folder);
    pack(pkg, join(folder, "hello.tgz"));
    for (const spec of ["./hello.tgz", "file:hello.tgz"]) {
      const ran = run("npx", ["-y", spec, "x"], undefined, folder);
      expect([spec, ran.status, ran.stderr]).toEqual([spec, 0, ""]);
      expect(JSON.parse(ran.stdout)).toEqual(["x"]);
    }
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

  test("npx runs a bin with no #! line through sh, and ends 126 on one it can't execute", () => {
    const plain = run("npx", ["eidolon-shim-plain", "a b", "$HOME"], undefined, below);
    expect([plain.status, plain.stdout, plain.stderr]).toEqual([4, "plain a b\nplain $HOME\n", ""]);
    const locked = run("npx", ["eidolon-shim-locked"], undefined, below);
    expect([locked.status, locked.stdout]).toEqual([126, ""]);
    expect(locked.stderr).toContain("EACCES");
  });

  test("npx passes SIGTERM and SIGINT on to the command, and ends as it then does", async () => {
    for (const [signal, ending] of [
      ["SIGTERM", "got-TERM\n"],
      ["SIGINT", "got-INT\n"],
    ] as const) {
      // In a process group of its own, killed should the signal never reach the command.
      const child = spawn(join(LAUNCHER_SOURCES, "npx"), ["eidolon-shim-trap"], {
        cwd: below,
        detached: true,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${LAUNCHER_SOURCES}`,
          EIDOLON_NODE: process.execPath,
        },
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout === "ready\n") child.kill(signal);
      });
      const group = -(child.pid as number);
      const killer = setTimeout(() => process.kill(group, "SIGKILL"), 15_000);
      const status = await new Promise((resolve) => child.on("close", resolve));
      clearTimeout(killer);
      expect([signal, status, stdout]).toEqual([
        signal,
        signal === "SIGTERM" ? 7 : 8,
        `ready\n${ending}`,
      ]);
    }
  }, 40_000);

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
  let registry = "";
  const old = "2020-01-01T00:00:00.000Z";

  /**
   * Publishes the package in `dir` at `time`, or with `time` undefined serves it at a URL pnpm
   * doesn't take for its registry's, which it would ask for the package's metadata.
   */
  function publish(dir: string, time?: string): string {
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

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    publish(
      write(join(scratch, "leaf"), {
        "package.json": JSON.stringify({ name: "eidolon-test-leaf", version: "1.0.0" }),
        "index.js": 'module.exports = "leaf";\n',
      }),
      old,
    );
    // Its postinstall prints, and npx's stdout must not show it.
    const dep = publish(
      write(join(scratch, "dep"), {
        "package.json": JSON.stringify({
          name: "eidolon-test-dep",
          version: "1.0.0",
          dependencies: { "eidolon-test-leaf": "1.0.0" },
          scripts: { postinstall: "node post.js" },
        }),
        "post.js": [
          'console.log("postinstall");',
          'const { join } = require("path");',
          'require("fs").writeFileSync(join(process.env.EIDOLON_TEST_MARKS, "dep"), "");',
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
        write(join(scratch, `app-${version}`), {
          "package.json": JSON.stringify({
            name: "eidolon-test-app",
            version,
            type: "module",
            bin: { "eidolon-test-app": "cli.mjs" },
            dependencies: { "eidolon-test-dep": dep },
          }),
          // eidolon-test-leaf is its dependency's, which npm's flat node_modules puts beside it.
          "cli.mjs": [
            "#!/usr/bin/env node",
            'import dep from "eidolon-test-dep";',
            'import { readFileSync } from "node:fs";',
            'import leaf from "eidolon-test-leaf";',
            'const url = new URL("../eidolon-test-leaf/package.json", import.meta.url);',
            'const beside = JSON.parse(readFileSync(url, "utf8")).name;',
            `const version = "${version}";`,
            "const args = process.argv.slice(2);",
            "console.log(JSON.stringify({ version, dep, leaf, beside, args }));",
            "",
          ].join("\n"),
        }),
        time,
      );
    }
    publish(
      write(join(scratch, "built"), {
        "package.json": JSON.stringify({
          name: "eidolon-test-built",
          version: "1.0.0",
          dependencies: { "eidolon-test-leaf": "1.0.0" },
          scripts: { postinstall: "node post.js" },
        }),
        "post.js": [
          'const { join } = require("path");',
          'require("fs").writeFileSync(join(process.env.EIDOLON_TEST_MARKS, "built"), "");',
          "",
        ].join("\n"),
      }),
      old,
    );
    for (const [version, time] of [
      ["1.0.0", old],
      ["1.1.0", new Date().toISOString()],
    ] as const) {
      publish(
        write(join(scratch, `fresh-${version}`), {
          "package.json": JSON.stringify({ name: "eidolon-test-fresh", version }),
        }),
        time,
      );
    }
    // Its only version is old, so pnpm resolves it alike with its day of release age and without,
    // all but its dependency eidolon-test-fresh, whose newest is new.
    publish(
      write(join(scratch, "pair"), {
        "package.json": JSON.stringify({
          name: "eidolon-test-pair",
          version: "1.0.0",
          type: "module",
          bin: { "eidolon-test-pair": "cli.mjs" },
          dependencies: { "eidolon-test-built": "1.0.0", "eidolon-test-fresh": "^1.0.0" },
        }),
        "cli.mjs": [
          "#!/usr/bin/env node",
          'import { createRequire } from "node:module";',
          'const fresh = createRequire(import.meta.url)("eidolon-test-fresh/package.json").version;',
          "let leaf;",
          "try {",
          '  leaf = (await import("eidolon-test-leaf")).default;',
          "} catch (error) {",
          "  leaf = error.code;",
          "}",
          "console.log(JSON.stringify({ fresh, leaf }));",
          "",
        ].join("\n"),
      }),
      old,
    );
  });
  afterAll(() => {
    server.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A home whose .npmrc names the registry served here, then `lines`. */
  function newHome(...lines: string[]): string {
    const home = mkdtempSync(join(scratch, "home-"));
    writeFileSync(join(home, ".npmrc"), [`registry=${registry}/`, ...lines, ""].join("\n"));
    return home;
  }

  /**
   * A launcher run from `cwd` with pnpm's store and caches in `home`, and the markers its
   * postinstalls left; spawnSync would hold the registry up.
   */
  async function launch(
    name: string,
    args: readonly string[],
    {
      home = newHome(),
      cwd = scratch,
      env = {},
    }: { home?: string; cwd?: string; env?: Record<string, string> } = {},
  ) {
    const marks = mkdtempSync(join(scratch, "marks-"));
    const child = spawn(join(LAUNCHER_SOURCES, name), args, {
      cwd,
      env: {
        HOME: home,
        PATH: `/usr/bin:/bin:${LAUNCHER_SOURCES}`,
        EIDOLON_NODE: process.execPath,
        EIDOLON_TEST_MARKS: marks,
        ...env,
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
    return { status, stdout, stderr, marks: readdirSync(marks) };
  }

  test("installs the newest, a dependency by URL with its postinstall, and runs it", async () => {
    const printed = { version: "1.1.0", dep: "dep", leaf: "leaf", beside: "eidolon-test-leaf" };
    expect(await launch("npx", ["-y", "eidolon-test-app", "x"])).toEqual({
      status: 0,
      stdout: `${JSON.stringify({ ...printed, args: ["x"] })}\n`,
      stderr: "",
      marks: ["dep"],
    });
    const missing = await launch("npx", ["-y", "eidolon-test-missing"]);
    expect([missing.status, missing.stdout]).toEqual([1, ""]);
    expect(missing.stderr).toContain("ERR_PNPM_FETCH_404");
  }, 60_000);

  test("reads no pnpmfile, as npm reads none", async () => {
    // A pnpm workspace around the folder npx runs in, whose pnpmfile would drop the app's dependency.
    const workspace = write(join(scratch, "workspace"), {
      "package.json": JSON.stringify({ name: "eidolon-test-workspace", private: true }),
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
      ".pnpmfile.cjs": [
        'const { join } = require("path");',
        'require("fs").writeFileSync(join(process.env.EIDOLON_TEST_MARKS, "pnpmfile"), "");',
        "const readPackage = (pkg) =>",
        '  pkg.name === "eidolon-test-app" ? { ...pkg, dependencies: {} } : pkg;',
        "module.exports = { hooks: { readPackage } };",
        "",
      ].join("\n"),
    });
    const cwd = join(workspace, "packages", "x");
    const ran = await launch("npx", ["-y", "eidolon-test-app"], { cwd });
    expect([ran.status, ran.marks, ran.stderr]).toEqual([0, ["dep"], ""]);
  }, 60_000);

  test("never shares an install with pnpx or pnpm dlx, which install as pnpm does", async () => {
    const asNpm = {
      status: 0,
      stdout: `${JSON.stringify({ fresh: "1.1.0", leaf: "leaf" })}\n`,
      stderr: "",
      marks: ["built"],
    };
    /** What eidolon-test-pair printed last. */
    const printed = (stdout: string) => JSON.parse(stdout.trimEnd().split("\n").at(-1) ?? "");
    const home = newHome();
    expect(await launch("npx", ["-y", "eidolon-test-pair"], { home })).toEqual(asNpm);
    // pnpm's own day of release age.
    expect(printed((await launch("pnpx", ["eidolon-test-pair"], { home })).stdout)).toMatchObject({
      fresh: "1.0.0",
    });
    const pnpmFirst = newHome();
    expect((await launch("pnpx", ["eidolon-test-pair"], { home: pnpmFirst })).status).toBe(0);
    expect(await launch("npx", ["-y", "eidolon-test-pair"], { home: pnpmFirst })).toEqual(asNpm);
  }, 60_000);

  test("installs as the owner's npm config has npm install", async () => {
    // ignore-scripts, in the user's .npmrc: the app runs, its dependency's postinstall never.
    const home = newHome("ignore-scripts=true");
    const ignoring = await launch("npx", ["-y", "eidolon-test-app"], { home });
    expect([ignoring.status, ignoring.marks, ignoring.stderr]).toEqual([0, [], ""]);
    // min-release-age, in an npm_config_* variable: an older dependency, though the home holds
    // npx's install of the newest.
    const pair = ["-y", "eidolon-test-pair"];
    const fresh = newHome();
    expect(JSON.parse((await launch("npx", pair, { home: fresh })).stdout).fresh).toBe("1.1.0");
    const aged = await launch("npx", pair, {
      home: fresh,
      env: { npm_config_min_release_age: "1" },
    });
    expect([aged.status, aged.stdout]).toEqual([
      0,
      `${JSON.stringify({ fresh: "1.0.0", leaf: "leaf" })}\n`,
    ]);
    // allow-remote, in the .npmrc at npm's local prefix: no dependency by URL.
    const project = write(join(scratch, "project"), {
      "package.json": JSON.stringify({ name: "eidolon-test-project" }),
      ".npmrc": "allow-remote=root\n",
      "sub/.keep": "",
    });
    const cwd = join(project, "sub");
    const remote = await launch("npx", ["-y", "eidolon-test-app"], { cwd });
    expect([remote.status, remote.stdout, remote.marks]).toEqual([1, "", []]);
    expect(remote.stderr).toContain("ERR_PNPM_EXOTIC_SUBDEP");
    // registry, in an npm_config_* variable, over the user's .npmrc, whose registry holds nothing.
    const nowhere = mkdtempSync(join(scratch, "home-"));
    writeFileSync(join(nowhere, ".npmrc"), `registry=${registry}/nothing/\n`);
    const named = await launch("npx", ["-y", "eidolon-test-app"], {
      home: nowhere,
      env: { npm_config_registry: `${registry}/` },
    });
    expect([named.status, named.marks, named.stderr]).toEqual([0, ["dep"], ""]);
    // strict-allow-scripts: nothing installed, and why.
    const strict = newHome("strict-allow-scripts=true");
    expect(await launch("npx", ["-y", "eidolon-test-app"], { home: strict })).toEqual({
      status: 1,
      stdout: "",
      stderr: "npx: strict-allow-scripts is set, and Eidolon's npx can't hold an install to it\n",
      marks: [],
    });
  }, 60_000);
});
