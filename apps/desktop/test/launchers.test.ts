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
      'if [ -n "$KILL" ]; then kill -"$KILL" $$; fi',
      "exit $((EXIT + 0))",
      "",
    ].join("\n"),
    // A script with no #! line, which only sh runs.
    "node_modules/.bin/eidolon-shim-plain": `printf 'plain %s\\n' "$@"\nexit 4\n`,
    "node_modules/.bin/eidolon-shim-locked": "#!/bin/sh\necho locked\n",
    "node_modules/.bin/eidolon-shim-lost": "#!/nonexistent/interpreter -x\necho lost\n",
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
      { EIDOLON_NODE: process.execPath, KILL: "TERM" },
      below,
    );
    expect([killed.status, killed.signal]).toEqual([null, "SIGTERM"]);
    // A signal Node ignores, which npx can't end on itself: 1, as npm's.
    const piped = run(
      "npx",
      ["eidolon-shim-local"],
      { EIDOLON_NODE: process.execPath, KILL: "PIPE" },
      below,
    );
    expect([piped.status, piped.signal]).toEqual([1, null]);
  });

  test("npx runs a bin with no #! line through sh, and ends 126 on one it can't execute", () => {
    const plain = run("npx", ["eidolon-shim-plain", "a b", "$HOME"], undefined, below);
    expect([plain.status, plain.stdout, plain.stderr]).toEqual([4, "plain a b\nplain $HOME\n", ""]);
    const locked = run("npx", ["eidolon-shim-locked"], undefined, below);
    expect([locked.status, locked.stdout]).toEqual([126, ""]);
    expect(locked.stderr).toContain("EACCES");
    // As sh says of it, where spawn reports the bin itself missing.
    const lost = run("npx", ["eidolon-shim-lost"], undefined, below);
    expect([lost.status, lost.stdout, lost.stderr]).toEqual([
      126,
      "",
      "npx: eidolon-shim-lost: /nonexistent/interpreter: bad interpreter: No such file or directory\n",
    ]);
  });

  test("npx ends 127 on a command nothing it installed or found has, as sh does", () => {
    const ran = run("npx", ["-y", "-p", pkg, "eidolon-shim-missing"]);
    expect([ran.status, ran.stdout, ran.stderr]).toEqual([
      127,
      "",
      "npx: eidolon-shim-missing: command not found\n",
    ]);
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
  // A private registry's path, served only with its token, and every request with its credential.
  const PRIVATE = "/corp";
  const TOKEN = "eidolon-test-token";
  const requests: { url: string; auth?: string }[] = [];
  /** Called with each request's path, while a test sets it. */
  let watch: ((url: string) => void) | undefined;
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? "/");
    requests.push({ url, auth: request.headers.authorization });
    watch?.(url);
    if (url.startsWith(`${PRIVATE}/`) && request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const file = files.get(url);
    const packument = packuments.get(url.slice(1));
    response.writeHead(file || packument ? 200 : 404);
    response.end(file ? readFileSync(file) : JSON.stringify(packument ?? { error: "Not found" }));
  });
  let registry = "";
  const old = "2020-01-01T00:00:00.000Z";
  // A package that prints, published, and taken from its folder, a tarball, a git repo and a URL.
  const hello = join(scratch, "hello");

  /**
   * Publishes the package in `dir` at `time` on the registry at the path `at`, or with `time`
   * undefined serves it at a URL pnpm doesn't take for its registry's, which it would ask for the
   * package's metadata.
   */
  function publish(dir: string, time?: string, at = ""): string {
    const { name, version, ...rest } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const urlPath =
      time === undefined
        ? `/plain/${name}-${version}.tgz`
        : `${at}/${name}/-/${name}-${version}.tgz`;
    const packed = pack(dir, join(scratch, `${at}${name}-${version}.tgz`.replace(/\//g, "+")));
    files.set(urlPath, packed.file);
    if (time === undefined) return `${registry}${urlPath}`;
    const key = `${at}/${name}`.slice(1);
    const packument = (packuments.get(key) ?? { name, versions: {}, time: {} }) as {
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
    packuments.set(key, packument);
    return `${registry}${urlPath}`;
  }

  /** A package whose command, its unscoped name, prints `says` and the words it was given. */
  function printer(dir: string, name: string, version: string, says: string): string {
    const bin = { [name.replace(/^@[^/]+\//, "")]: "cli.js" };
    return write(dir, {
      "package.json": JSON.stringify({ name, version, bin }),
      "cli.js": [
        "#!/usr/bin/env node",
        `console.log(${JSON.stringify(says)}, JSON.stringify(process.argv.slice(2)));`,
        "",
      ].join("\n"),
    });
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
    // Bins npm links and runs, whose path and name pnpm doesn't take.
    for (const [name, bin] of [
      ["eidolon-test-abs", "/cli.js"],
      ["eidolon-test-plus", { "eidolon-test+plus": "cli.js" }],
    ] as const) {
      publish(
        write(join(scratch, name), {
          "package.json": JSON.stringify({ name, version: "1.0.0", bin }),
          "cli.js": "#!/usr/bin/env node\nconsole.log('own');\n",
        }),
        old,
      );
    }
    // A private package, and one of its name on the registry the user's .npmrc names, which a
    // project whose own .npmrc pnpm misses would get in its place.
    publish(printer(join(scratch, "corp"), "@eidolon-corp/tool", "1.0.0", "corp"), old, PRIVATE);
    publish(printer(join(scratch, "impostor"), "@eidolon-corp/tool", "9.0.0", "impostor"), old);
    // One name on two registries, at two versions.
    publish(printer(join(scratch, "mirror-a"), "eidolon-test-mirror", "1.0.0", "a"), old, "/a");
    publish(printer(join(scratch, "mirror-b"), "eidolon-test-mirror", "2.0.0", "b"), old, "/b");
    publish(printer(hello, "eidolon-test-hello", "1.0.0", "hello"), old);
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

  test("runs nothing else for a bin pnpm doesn't link, where npm runs the package's", async () => {
    // Programs of the bins' names further down PATH, which npm never reaches.
    const other = write(join(scratch, "other"), {
      "eidolon-test-abs": "#!/bin/sh\necho other\n",
      "eidolon-test+plus": "#!/bin/sh\necho other\n",
    });
    const env = { PATH: `/usr/bin:/bin:${LAUNCHER_SOURCES}:${other}` };
    for (const [args, command] of [
      [["-y", "eidolon-test-abs"], "eidolon-test-abs"],
      [["-y", "-p", "eidolon-test-plus", "eidolon-test+plus"], "eidolon-test+plus"],
    ] as const) {
      expect(await launch("npx", args, { env })).toEqual({
        status: 127,
        stdout: "",
        stderr: `npx: ${command}: pnpm doesn't link a bin by this name\n`,
        marks: [],
      });
    }
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

  /** The private registry's settings for an .npmrc, its token as `token` gives it. */
  const privateNpmrc = (token: string) =>
    [
      `@eidolon-corp:registry=${registry}${PRIVATE}/`,
      `${registry.slice("http:".length)}${PRIVATE}/:_authToken=${token}`,
      "",
    ].join("\n");

  test("installs from the registries, with the credentials, of the .npmrc npm reads", async () => {
    // At npm's local prefix, an npm workspace's root, with ${VAR} expanded as npm does, which pnpm
    // refuses in a project's .npmrc.
    const npmrc = privateNpmrc(`\${EIDOLON_TEST_TOKEN}`);
    const workspace = write(join(scratch, "npm-workspace"), {
      "package.json": JSON.stringify({ name: "eidolon-test-root", workspaces: ["packages/*"] }),
      ".npmrc": npmrc,
      "packages/a/package.json": JSON.stringify({ name: "eidolon-test-a", version: "1.0.0" }),
    });
    const project = write(join(scratch, "npm-project"), {
      "package.json": JSON.stringify({ name: "eidolon-test-project", version: "1.0.0" }),
      ".npmrc": npmrc,
      "sub/.keep": "",
    });
    const ran = [];
    for (const cwd of [join(workspace, "packages", "a"), join(project, "sub")]) {
      const env = { EIDOLON_TEST_TOKEN: TOKEN };
      ran.push(await launch("npx", ["-y", "@eidolon-corp/tool", "x"], { cwd, env }));
    }
    const corp = { status: 0, stdout: 'corp ["x"]\n', stderr: "", marks: [] };
    expect(ran).toEqual([corp, corp]);
  }, 60_000);

  test("fails as npm does on a registry an unset variable names, never taking the user's", async () => {
    // npm takes the ${VAR} as written, for an invalid URL.
    const project = write(join(scratch, "npm-project-unset"), {
      "package.json": JSON.stringify({ name: "eidolon-test-project", version: "1.0.0" }),
      ".npmrc": privateNpmrc(TOKEN).replace(`${registry}${PRIVATE}/`, `\${EIDOLON_TEST_UNSET}`),
    });
    const asked = requests.length;
    const ran = await launch("npx", ["-y", "@eidolon-corp/tool", "x"], { cwd: project });
    expect([ran.status, ran.stdout, requests.slice(asked)]).toEqual([1, "", []]);
    expect(ran.stderr).toContain("Invalid URL");
  }, 60_000);

  test("gives pnpm no registry a variable names in its arguments, which any process reads", async () => {
    // A registry whose path holds its token, as some do.
    const token = "/eidolon-test-path-token";
    publish(printer(join(scratch, "pathed"), "eidolon-test-pathed", "1.0.0", "pathed"), old, token);
    // What ps shows, at each request for it, of the processes running.
    const shown: string[][] = [];
    watch = (url) => {
      if (!url.startsWith(`${token}/`)) return;
      const ps = spawnSync("ps", ["-A", "-ww", "-o", "args="], { encoding: "utf8" });
      shown.push(
        ps.status === 0 ? ps.stdout.split("\n").filter((line) => line.includes(token)) : ["ps"],
      );
    };
    try {
      const env = { npm_config_registry: `${registry}${token}/` };
      const ran = await launch("npx", ["-y", "eidolon-test-pathed", "x"], { env });
      expect([ran.status, ran.stdout, ran.stderr]).toEqual([0, 'pathed ["x"]\n', ""]);
    } finally {
      watch = undefined;
    }
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.flat()).toEqual([]);
  }, 60_000);

  test("reads no .npmrc npm leaves unread: a workspace's own, or a pnpm workspace's", async () => {
    const nowhere = `registry=${registry}/nowhere/\n@eidolon-corp:registry=${registry}/nowhere/\n`;
    const workspace = write(join(scratch, "npm-workspace-own"), {
      "package.json": JSON.stringify({ name: "eidolon-test-root", workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({ name: "eidolon-test-a", version: "1.0.0" }),
      "packages/a/.npmrc": nowhere,
    });
    const pnpmWorkspace = write(join(scratch, "pnpm-workspace-around"), {
      "pnpm-workspace.yaml": 'packages:\n  - "sub"\n',
      ".npmrc": nowhere,
      "sub/package.json": JSON.stringify({ name: "eidolon-test-sub", version: "1.0.0" }),
      "sub/.npmrc": privateNpmrc(TOKEN),
    });
    const ran = [
      await launch("npx", ["-y", "eidolon-test-hello", "x"], {
        cwd: join(workspace, "packages", "a"),
      }),
      await launch("npx", ["-y", "@eidolon-corp/tool", "x"], { cwd: join(pnpmWorkspace, "sub") }),
    ];
    expect(ran).toEqual([
      { status: 0, stdout: 'hello ["x"]\n', stderr: "", marks: [] },
      { status: 0, stdout: 'corp ["x"]\n', stderr: "", marks: [] },
    ]);
  }, 60_000);

  test("keeps the installs from one project's registry apart from another's", async () => {
    const home = newHome();
    const projectOf = (at: string) =>
      write(join(scratch, `mirror-project-${at}`), {
        "package.json": JSON.stringify({ name: `eidolon-test-mirror-${at}`, version: "1.0.0" }),
        ".npmrc": `registry=${registry}/${at}/\n`,
      });
    for (const at of ["a", "b", "a"]) {
      const ran = await launch("npx", ["-y", "eidolon-test-mirror"], { home, cwd: projectOf(at) });
      expect([at, ran.status, ran.stdout]).toEqual([at, 0, `${at} []\n`]);
    }
  }, 60_000);

  /** A bare git repo of the package in `dir`, made without the developer's git config. */
  function gitRepo(dir: string): string {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const work = mkdtempSync(join(scratch, "git-work-"));
    const bare = `${work}.git`;
    const git = (cwd: string, ...args: string[]) => {
      const ran = spawnSync("git", args, { cwd, env, encoding: "utf8" });
      expect([args, ran.status, ran.stderr]).toEqual([args, 0, ""]);
    };
    spawnSync("cp", ["-R", `${dir}/.`, work]);
    git(work, "-c", "init.defaultBranch=main", "init", "-q");
    git(work, "add", "-A");
    git(
      work,
      "-c",
      "user.name=Eidolon",
      "-c",
      "user.email=eidolon@example.test",
      "commit",
      "-qm",
      "x",
    );
    git(scratch, "clone", "-q", "--bare", work, bare);
    return bare;
  }

  test("refuses a git, URL, tarball or folder package allow-* is none for, as npm", async () => {
    const folder = mkdtempSync(join(scratch, "kinds-"));
    pack(hello, join(folder, "hello.tgz"));
    const repo = gitRepo(hello);
    const kinds = [
      ["git", `git+file://${repo}`, `Refusing to fetch "git+file://${repo}"`],
      ["remote", `${registry}/eidolon-test-hello/-/eidolon-test-hello-1.0.0.tgz`],
      ["file", "./hello.tgz"],
      ["directory", hello],
    ] as const;
    const refused = [];
    const allowed = [];
    for (const [kind, spec] of kinds) {
      const asked = requests.length;
      const env = { [`npm_config_allow_${kind}`]: "none" };
      const ran = await launch("npx", ["-y", spec, "x"], { cwd: folder, env });
      refused.push({ ...ran, asked: requests.length - asked });
      // npx's own packages are the root's, which root lets through.
      const root = { [`npm_config_allow_${kind}`]: "root" };
      const { status, stdout } = await launch("npx", ["-y", spec, "x"], { cwd: folder, env: root });
      allowed.push({ status, stdout });
    }
    expect(refused).toEqual(
      kinds.map(([kind, , ...more]) => ({
        status: 1,
        stdout: "",
        stderr: [
          `code EALLOW${kind.toUpperCase()}`,
          `Fetching packages of type "${kind}" have been disabled`,
          ...more,
        ]
          .map((line) => `npx: ${line}\n`)
          .join(""),
        marks: [],
        asked: 0,
      })),
    );
    expect(allowed).toEqual(kinds.map(() => ({ status: 0, stdout: 'hello ["x"]\n' })));
  }, 120_000);
});
