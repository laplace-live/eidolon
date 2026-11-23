// The node shim's npx deciding as npm's does, on folders made here and nothing spawned: its
// arguments, pnpm's, npm's local prefix and workspaces, the local bins and installed packages it
// runs rather than install, the bin it picks, npm's PATH, and how it finds and starts a command,
// on Windows too.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { LAUNCHER_SOURCES } from "../scripts/node-shim.ts";

type Env = Record<string, string | undefined>;
type Source = Record<string, string | string[]>;
type Installed = { dir: string; manifest: { name: string; version?: string } };
type Plan = (
  | { error: string; code?: number }
  | { install?: string[]; command?: string; args: string[]; bins: string[]; runPath: string }
) & { warnings?: string[] };
type Current = Record<string, { name?: string; version?: string }>;
interface Npx {
  envReplace(text: string, env: Env): string;
  npmConfig(env: Env, prefix: string, home: string): Source[];
  pnpmNpmrc(sources: readonly Source[], cwd: string, home: string): string;
  npxSettings(sources: readonly Source[], now?: number): string[] | { error: string };
  invalidConfig(sources: readonly Source[]): string | undefined;
  devEngines(
    manifest: unknown,
    force: boolean,
    current: Current,
  ): { warnings: string[]; error?: string };
  npmSpec(
    spec: string,
    where: string,
    home: string,
    platform?: string,
  ): { type: string; name?: string; saveSpec?: string; path?: string } | undefined;
  refusal(
    specs: readonly string[],
    sources: readonly Source[],
    cwd: string,
    home: string,
  ): string | undefined;
  readNpx(args: readonly string[]): { packages: string[]; command: string[] } | { error: string };
  npxToPnpm(
    packages: readonly string[],
    settings: readonly string[],
    cwd: string,
    home: string,
    platform?: string,
  ): string[];
  localSpec(
    spec: string,
    cwd: string,
    home: string,
    platform?: string,
  ): { path: string; tarball: boolean } | undefined;
  binsOf(manifest: object, dir: string): Record<string, string>;
  binOf(manifest: object, dir: string): string | undefined;
  npmPrefix(cwd: string): { prefix: string; workspace?: string };
  localBin(start: string, name: string): string | undefined;
  treePackages(prefix: string): Installed[];
  inTree(packages: readonly Installed[], spec: string): Installed | undefined;
  plan(args: readonly string[], cwd: string, home?: string, env?: Env, current?: Current): Plan;
  pathOf(env: Env, delimiter?: string): string;
  npmPath(bins: readonly string[], runPath: string, nodeGyp: string, rest: string): string;
  commandEnv(env: Env, value: string): Env;
  which(
    command: string,
    options: { pathEnv: string; cwd: string; platform?: string; pathext?: string },
  ): string | undefined;
  spawnArgs(
    file: string,
    args: readonly string[],
    options?: { platform?: string; env?: Env },
  ): { command: string; args: string[]; verbatim: boolean };
  relay(child: { kill(signal: string): void }, platform?: string): () => void;
}
interface CrossSpawn {
  escapeCommand(command: string): string;
  escapeArgument(arg: string, doubleEscape: boolean): string;
}
const npx: Npx = await import(pathToFileURL(join(LAUNCHER_SOURCES, "npx.mjs")).href);
const cross: CrossSpawn = await import(
  pathToFileURL(join(LAUNCHER_SOURCES, "cross-spawn.mjs")).href
);
/** pnpm's settings under npm's default config. */
const DEFAULTS = npx.npxSettings([]) as string[];

const root = realpathSync(mkdtempSync(join(tmpdir(), "eidolon-npx-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// A bin no folder above the scratch one holds.
const TOOL = `eidolon-npx-tool-${process.pid}`;

/** Writes `files` under a new folder in the scratch one, executable, a null one a folder. */
function tree(files: Record<string, string | null>): string {
  const base = mkdtempSync(join(root, "t-"));
  for (const [name, text] of Object.entries(files)) {
    const file = join(base, name);
    if (text === null) {
      mkdirSync(file, { recursive: true });
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    chmodSync(file, 0o755);
  }
  return base;
}

const manifest = (fields: object) => JSON.stringify({ version: "1.0.0", ...fields });

describe("npx's arguments", () => {
  test("leave out -y, --yes, -q and --quiet, and keep the command and every word after it", () => {
    expect(npx.readNpx(["-y", "@modelcontextprotocol/server-filesystem", "/tmp", "-y"])).toEqual({
      packages: [],
      command: ["@modelcontextprotocol/server-filesystem", "/tmp", "-y"],
    });
    expect(npx.readNpx(["--yes", "-q", "--quiet", "server@1.2.3", "--port=1", "-c", "--"])).toEqual(
      {
        packages: [],
        command: ["server@1.2.3", "--port=1", "-c", "--"],
      },
    );
  });

  test("take each package -p, -p=, --package and --package= name, in order", () => {
    expect(
      npx.readNpx(["-p", "a", "--package", "b@2", "--package=@c/d", "-p=e", "run", "-x"]),
    ).toEqual({
      packages: ["a", "b@2", "@c/d", "e"],
      command: ["run", "-x"],
    });
  });

  test("after --, take the next word as the command, whatever it starts with", () => {
    expect(npx.readNpx(["-y", "--", "-odd", "--", "x"])).toEqual({
      packages: [],
      command: ["-odd", "--", "x"],
    });
  });

  test("refuse an option they don't take, a package option with none, and nothing to run", () => {
    for (const [args, error] of [
      [["-c", "echo hi"], "Eidolon's npx doesn't take -c"],
      [["--call=echo $TOKEN"], "Eidolon's npx doesn't take --call"],
      [["-yq", "server"], "Eidolon's npx doesn't take -yq"],
      [["--registry=https://example.test", "server"], "Eidolon's npx doesn't take --registry"],
      [["-y", "-p"], "-p needs a package"],
      [["-p=", "server"], "-p needs a package"],
      [["--package=", "server"], "--package needs a package"],
      [[], "nothing to run"],
      [["-y", "--"], "nothing to run"],
      [["--package", "a"], "nothing to run"],
    ] as const) {
      expect([args, npx.readNpx(args)]).toEqual([args, { error }]);
    }
  });
});

describe("pnpm's arguments", () => {
  const dlx = (...packages: string[]) => [
    "--loglevel=error",
    ...DEFAULTS,
    "dlx",
    expect.stringMatching(/^--allow-build=\.npx-[0-9a-f]{16}$/),
    ...packages.map((spec) => `--package=${spec}`),
  ];

  test("set pnpm to install as npm does: all builds, no release age, git and URL deps", () => {
    expect(DEFAULTS).toEqual([
      "--config.dangerously-allow-all-builds=true",
      "--config.minimum-release-age=0",
      "--config.block-exotic-subdeps=false",
      "--config.node-linker=hoisted",
      "--config.ignore-pnpmfile=true",
    ]);
  });

  test("pass registry, git and URL specs on as they are", () => {
    const specs = [
      "server",
      "@scope/server@1.2.3",
      "server@^2",
      "user/repo",
      "github:user/repo#main",
      "git+https://example.test/server.git",
      "git@github.com:user/repo.git",
      "https://example.test/server.tgz",
    ];
    expect(npx.npxToPnpm(specs, DEFAULTS, "/work", "/home/me")).toEqual(dlx(...specs));
  });

  // A name a spec gives either, npm runs the package's own bins under.
  test("give a folder as pnpm's link:, absolute and unnamed, which npm links too", () => {
    expect(
      npx.npxToPnpm(
        ["./server", "file:../other", "named@./third", "~/fourth", "@s/n@file:../fifth"],
        DEFAULTS,
        "/work/here",
        "/home/me",
      ),
    ).toEqual(
      dlx(
        "link:/work/here/server",
        "link:/work/other",
        "link:/work/here/third",
        "link:/home/me/fourth",
        "link:/work/fifth",
      ),
    );
  });

  test("give a tarball file absolute and unnamed, which pnpm would look for in its dlx folder", () => {
    expect(
      npx.npxToPnpm(
        ["./server-1.0.0.tgz", "file:../server.tar.gz", "x.tgz", "named@./y.tar", "~/z.tgz"],
        DEFAULTS,
        "/work/here",
        "/home/me",
      ),
    ).toEqual(
      dlx(
        "file:/work/here/server-1.0.0.tgz",
        "file:/work/server.tar.gz",
        "file:/work/here/x.tgz",
        "file:/work/here/y.tar",
        "file:/home/me/z.tgz",
      ),
    );
  });

  test("key each set of settings' installs apart in pnpm's dlx cache", () => {
    const keyOf = (settings: readonly string[]) =>
      npx
        .npxToPnpm(["server"], settings, "/work", "/home/me")
        .find((arg) => arg.startsWith("--allow-build="));
    const ignoring = npx.npxSettings([{ "ignore-scripts": "true" }]) as string[];
    expect(keyOf(DEFAULTS)).toBe(keyOf([...DEFAULTS]));
    expect(keyOf(ignoring)).not.toBe(keyOf(DEFAULTS));
  });
});

describe("npm's config, which npx installs by", () => {
  const NOW = Date.parse("2026-11-23T12:00:00Z");
  const settingsOf = (...sources: Source[]) => npx.npxSettings(sources, NOW);

  test("runs no install script under ignore-scripts, read as npm reads a boolean", () => {
    for (const value of ["true", "1", "yes"]) {
      expect([value, settingsOf({ "ignore-scripts": value })]).toEqual([
        value,
        ["--config.ignore-scripts=true", ...DEFAULTS.slice(1)],
      ]);
    }
    for (const value of ["false", "0", "null", ""]) {
      expect([value, settingsOf({ "ignore-scripts": value })]).toEqual([value, DEFAULTS]);
    }
  });

  test("holds a version back by min-release-age or before, from the highest source", () => {
    const age = (...sources: Record<string, string>[]) =>
      (settingsOf(...sources) as string[]).find((setting) => setting.includes("release-age"));
    expect(age({ "min-release-age": "7" })).toBe("--config.minimum-release-age=10080");
    expect(age({ "min-release-age": "0.5" })).toBe("--config.minimum-release-age=720");
    expect(age({ before: "2026-11-20T12:00:00Z" })).toBe("--config.minimum-release-age=4320");
    expect(age({ before: "2026-11-30" })).toBe("--config.minimum-release-age=0");
    // before wins within a source, and a higher source over a lower one, either way.
    expect(age({ "min-release-age": "7", before: "2026-11-22T12:00:00Z" })).toBe(
      "--config.minimum-release-age=1440",
    );
    expect(age({ "min-release-age": "0" }, { "min-release-age": "7" })).toBe(
      "--config.minimum-release-age=0",
    );
    expect(age({}, { "min-release-age": "1" }, { before: "2020-01-01" })).toBe(
      "--config.minimum-release-age=1440",
    );
    expect(age({ "min-release-age": "soon" })).toBe("--config.minimum-release-age=0");
  });

  test("blocks a dependency's git and URL dependencies under allow-git or allow-remote", () => {
    const blocks = (source: Record<string, string>) =>
      (settingsOf(source) as string[]).includes("--config.block-exotic-subdeps=true");
    const blocking: Record<string, string>[] = [
      { "allow-git": "root" },
      { "allow-git": "none" },
      { "allow-remote": "root" },
      { "allow-remote": "none" },
    ];
    for (const source of blocking) {
      expect([source, blocks(source)]).toEqual([source, true]);
    }
    expect(blocks({ "allow-git": "all", "allow-remote": "all" })).toBe(false);
  });

  test("takes a registry from npm_config_* variables, over the project's, off pnpm's arguments", () => {
    const env = {
      NPM_CONFIG_REGISTRY: "https://npm.corp.test/",
      "npm_config_@Corp:registry": "https://corp.test/npm/",
      "npm_config_//npm.corp.test/:_authToken": "secret",
      npm_config_registry_x: "https://x.test/",
    };
    const [variables = {}] = npx.npmConfig(env, root, root);
    // Any process can read pnpm's arguments, and a registry's URL can hold its token.
    expect(settingsOf(variables, { registry: "https://user.test/" })).toEqual(DEFAULTS);
    const project = { registry: "https://project.test/", "@other:registry": "https://other.test/" };
    // pnpm reads the user's .npmrc, and npm_config_//… credentials, itself.
    expect(npx.pnpmNpmrc([variables, project], "/work", "/home").split("\n")).toEqual([
      '"registry"="https://npm.corp.test/"',
      '"@other:registry"="https://other.test/"',
      '"@corp:registry"="https://corp.test/npm/"',
    ]);
  });

  test("installs nothing under strict-allow-scripts, but with every script or none", () => {
    expect(settingsOf({ "strict-allow-scripts": "true" })).toEqual({
      error: "strict-allow-scripts is set, and Eidolon's npx can't hold an install to it",
    });
    expect(
      settingsOf({ "strict-allow-scripts": "true", "dangerously-allow-all-scripts": "true" }),
    ).toEqual(DEFAULTS);
    expect(settingsOf({ "strict-allow-scripts": "true" }, { "ignore-scripts": "true" })).toEqual([
      "--config.ignore-scripts=true",
      ...DEFAULTS.slice(1),
    ]);
  });

  test("comes from npm_config_* variables, the .npmrc at npm's local prefix, then the user's", () => {
    const base = tree({
      "project/.npmrc": [
        "; a comment",
        "ignore-scripts = true ; and another",
        "allow-git='root'",
        "strict-allow-scripts",
        "[section]",
        "before=2020-01-01",
        "",
      ].join("\r\n"),
      "home/.npmrc": "min-release-age=7\nallow-remote=none\n",
      "other/.npmrc": "allow-remote=root\n",
    });
    const project = join(base, "project");
    const home = join(base, "home");
    const env = {
      NPM_CONFIG_MIN_RELEASE_AGE: "3",
      npm_config_Strict_Allow_Scripts: "false",
      npm_config_allow_git: "",
      PATH: "/bin",
    };
    expect(npx.npmConfig(env, project, home)).toEqual([
      { "min-release-age": "3", "strict-allow-scripts": "false" },
      { "ignore-scripts": "true", "allow-git": "root", "strict-allow-scripts": "true" },
      { "min-release-age": "7", "allow-remote": "none" },
    ]);
    const userconfig = join(base, "other", ".npmrc");
    expect(npx.npmConfig({ npm_config_userconfig: userconfig }, project, home)[2]).toEqual({
      "allow-remote": "root",
    });
    // In the home, the project's .npmrc is the user's, which npm reads once.
    expect(npx.npmConfig({}, home, home)).toEqual([
      {},
      {},
      { "min-release-age": "7", "allow-remote": "none" },
    ]);
  });

  test("reads an .npmrc's values as npm's ini parser does, quotes, escapes and lists", () => {
    const base = tree({
      ".npmrc": [
        "plain = a b ; a comment",
        "hash=a#b",
        String.raw`escaped=a\;b\#c\\d\x`,
        String.raw`json="a;b#c\"d"`,
        "single='x;y'",
        "number='12'",
        "bare",
        "dup=1",
        "dup=2",
        "ca[]=one",
        "ca[]=two",
        "  # a comment",
        "=no key",
        "__proto__=x",
        "[section]",
        "after=unread",
      ].join("\n"),
    });
    expect(npx.npmConfig({}, base, root)[1]).toEqual({
      plain: "a b",
      hash: "a",
      escaped: String.raw`a;b#c\d\x`,
      json: 'a;b#c"d',
      single: "x;y",
      number: "12",
      bare: "true",
      dup: "2",
      ca: ["one", "two"],
    });
  });

  test("expands the variables every source's keys and values name, as npm does", () => {
    const env = { HOST: "npm.corp.test", TOKEN: "t0k", EMPTY: "" };
    // An escaped \${ stays, and each pair of backslashes before one is one.
    expect(
      npx.envReplace(`\${TOKEN}-\${UNSET}-\${UNSET?}-\${EMPTY}-\\\${TOKEN}-\\\\\${TOKEN}`, env),
    ).toBe(`t0k-\${UNSET}---\${TOKEN}-\\t0k`);
    // Keys once the file is read: of two that expand alike, the one that first comes later wins.
    const base = tree({
      ".npmrc": [
        `//\${HOST}/:_authToken=first`,
        "//npm.corp.test/:_authToken=literal",
        `//\${HOST}/:_authToken=\${TOKEN}`,
        `registry=https://\${HOST}/`,
      ].join("\n"),
    });
    const before = ` \${EMPTY}2020-01-01 `;
    expect(npx.npmConfig({ ...env, npm_config_before: before }, base, root).slice(0, 2)).toEqual([
      { before: "2020-01-01" },
      { "//npm.corp.test/:_authToken": "literal", registry: "https://npm.corp.test/" },
    ]);
    expect(
      npx.npmConfig(env, tree({ ".npmrc": `//\${HOST}/:_authToken=\${TOKEN}` }), root)[1],
    ).toEqual({ "//npm.corp.test/:_authToken": "t0k" });
  });

  test("gives pnpm the project's registries, their credentials and certificates, as npm", () => {
    const cwd = tree({ "certs/client.pem": "cert", "certs/client.key": "key" });
    const project: Source = {
      registry: "https://npm.corp.test/",
      "@corp:registry": "https://corp.test/npm/",
      "//corp.test/npm/:_authToken": 'to"k;en=',
      "//corp.test/npm/:certfile": "certs/client.pem",
      "//corp.test/npm/:keyfile": join(cwd, "certs", "client.key"),
      cafile: "~/ca.pem",
      ca: ["one", "two"],
      // Settings npm doesn't install by or doesn't have, and values it takes as none.
      "//corp.test/npm/:tokenHelper": "/bin/helper",
      "//corp.test/npm/:ca": "pem",
      _authToken: "unscoped",
      "ignore-scripts": "true",
      "@other:registry": "",
      "@list:registry": ["https://a.test/", "https://b.test/"],
      // A client certificate whose key isn't there, which npm presents none of.
      "//half.test/:certfile": "certs/client.pem",
      "//half.test/:keyfile": "certs/missing.key",
    };
    expect(npx.pnpmNpmrc([{}, project], cwd, "/home/me").split("\n")).toEqual([
      '"registry"="https://npm.corp.test/"',
      '"@corp:registry"="https://corp.test/npm/"',
      String.raw`"//corp.test/npm/:_authToken"="to\"k;en="`,
      `"//corp.test/npm/:certfile"=${JSON.stringify(join(cwd, "certs", "client.pem"))}`,
      `"//corp.test/npm/:keyfile"=${JSON.stringify(join(cwd, "certs", "client.key"))}`,
      '"cafile"="/home/me/ca.pem"',
      '"ca[]"="one"',
      '"ca[]"="two"',
    ]);
    expect(npx.pnpmNpmrc([{}, { cafile: "ca.pem" }], "/work", "/home")).toBe(
      '"cafile"="/work/ca.pem"',
    );
    expect(npx.pnpmNpmrc([{}, { "ignore-scripts": "true" }], "/work", "/home")).toBe("");
  });

  test("keeps a value whose variable is unset as npm has it, which pnpm would ignore", () => {
    // npm then fails on an invalid URL or a wrong token; pnpm would take the user's registry.
    const host = `\${HOST}`;
    const project: Source = {
      "@corp:registry": `\${CORP_REGISTRY}`,
      registry: `http://${host}/npm/`,
      "//corp.test/:_authToken": `a\${TOKEN}{b}$c`,
      cafile: `\${CA}.pem`,
      // A key naming no registry.
      [`//${host}/:_authToken`]: "unused",
    };
    expect(npx.pnpmNpmrc([{}, project], "/work", "/home").split("\n")).toEqual([
      '"@corp:registry"="%24%7BCORP_REGISTRY%7D"',
      '"registry"="http://%24%7BHOST%7D/npm/"',
      '"//corp.test/:_authToken"="a%24%7BTOKEN%7D%7Bb%7D%24c"',
      '"cafile"="/work/%24%7BCA%7D.pem"',
    ]);
    // A variable's too.
    expect(npx.pnpmNpmrc([{ "@v:registry": `\${V}` }, {}], "/work", "/home")).toBe(
      '"@v:registry"="%24%7BV%7D"',
    );
  });
});

describe("npm's config it runs no command under", () => {
  const authError = (...problems: string[]) =>
    [
      "code ERR_INVALID_AUTH",
      `Invalid auth configuration found: ${problems.join(", ")}`,
      "Please run `npm config fix` to repair your configuration.`",
    ].join("\n");

  // Each as npm 11.19.1 printed it.
  test("is a credential the user's or the project's .npmrc gives no registry", () => {
    const project = { _authToken: "t", "//r.test/:_authToken": "scoped" };
    const user = { _authtoken: "t", username: "u", _password: "cA==", "-authtoken": "x" };
    expect(npx.invalidConfig([{ registry: "https://r.test/npm/x" }, project, user])).toBe(
      authError(
        "`_authtoken` is not allowed in user config",
        "`-authtoken` is not allowed in user config",
        "`username` must be renamed to `//r.test/npm/:username` in user config",
        "`_password` must be renamed to `//r.test/npm/:_password` in user config",
        "`_authToken` must be renamed to `//r.test/npm/:_authToken` in project config",
      ),
    );
    // A username or a password alone.
    expect(npx.invalidConfig([{}, { username: "u" }, { _password: "p", _auth: "a" }])).toBe(
      authError(
        "`_auth` must be renamed to `//registry.npmjs.org/:_auth` in user config",
        "`_password` is not allowed in user config",
        "`username` is not allowed in project config",
      ),
    );
    // Values npm takes as none, and a variable's, which it doesn't check.
    const none = { _authToken: "false", username: "null", _auth: "" };
    expect(npx.invalidConfig([{ _authtoken: "t" }, none, {}])).toBeUndefined();
  });

  test("is a registry that isn't a URL, a scope's aside", () => {
    for (const registry of ["", "true", "not a url"]) {
      expect([registry, npx.invalidConfig([{}, { registry }, { _auth: "a" }])]).toEqual([
        registry,
        "code ERR_INVALID_URL\nInvalid URL",
      ]);
    }
    expect(npx.invalidConfig([{ "@s:registry": "not a url" }, {}, {}])).toBeUndefined();
  });
});

describe("a project's devEngines, as npm checks it before any command", () => {
  const current: Current = {
    cpu: { name: "arm64" },
    libc: { name: undefined },
    os: { name: "darwin", version: "27.2.0" },
    packageManager: { name: "npm", version: "11.19.1" },
    runtime: { name: "node", version: "v24.22.1" },
  };
  const check = (devEngines: unknown, force = false) =>
    npx.devEngines({ name: "p", devEngines }, force, current);
  const header = "The developer of this package has specified the following through devEngines";
  /** Lines as npm prints them under the title `EBADDEVENGINES`. */
  const titled = (...lines: string[]) =>
    lines.map((line) => (line ? `EBADDEVENGINES ${line}` : "EBADDEVENGINES"));
  const pnpm = [
    "Invalid devEngines.packageManager",
    'Invalid name "pnpm" does not match "npm" for "packageManager"',
    "{",
    "  current: { name: 'npm', version: '11.19.1' },",
    "  required: { name: 'pnpm', onFail: 'download' }",
    "}",
  ];

  // Each as npm 11.19.1 printed it.
  test("ends on the first engine none of whose choices match", () => {
    expect(check({ packageManager: { name: "pnpm", onFail: "download" } })).toEqual({
      warnings: [],
      error: ["code EBADDEVENGINES", ...titled(header, ...pnpm)].join("\n"),
    });
    const cpu = { cpu: { name: "x64" }, os: { name: "darwin", version: ">=99" } };
    expect(check(cpu).error?.split("\n")).toEqual([
      "code EBADDEVENGINES",
      ...titled(
        header,
        "Invalid devEngines.cpu",
        'Invalid name "x64" does not match "arm64" for "cpu"',
        "{ current: { name: 'arm64' }, required: { name: 'x64' } }",
      ),
    ]);
    expect(check({ runtime: { name: "node", version: "latest" } }).error).toContain(
      'Invalid version "latest" does not match "v24.22.1" for "runtime"',
    );
  });

  test("warns of an engine whose last choice says warn, or of any under force, and goes on", () => {
    const authored = {
      cpu: { name: "x64", onFail: "warn" },
      packageManager: { name: "pnpm", onFail: "download" },
      runtime: { name: "bun", onFail: "ignore" },
    };
    const cpu = [
      "Invalid devEngines.cpu",
      'Invalid name "x64" does not match "arm64" for "cpu"',
      "{",
      "  current: { name: 'arm64' },",
      "  required: { name: 'x64', onFail: 'warn' }",
      "}",
    ];
    const warned = (...lines: string[]) => titled(...lines).map((line) => `warn ${line}`);
    expect(check(authored)).toEqual({
      warnings: warned(header, ...cpu),
      error: ["code EBADDEVENGINES", ...titled(header, ...pnpm)].join("\n"),
    });
    expect(check(authored, true)).toEqual({ warnings: warned(header, ...cpu, ...pnpm) });
  });

  test("lets through engines one of whose choices matches, and none listed", () => {
    for (const authored of [
      { packageManager: { name: "npm", version: "^11.19" }, runtime: { name: "node" } },
      { runtime: [{ name: "bun" }, { name: "node", version: "v24.22.1" }] },
      { runtime: [], os: { name: "darwin", version: ">=27" } },
    ]) {
      expect([authored, check(authored)]).toEqual([authored, { warnings: [] }]);
    }
    expect(npx.devEngines({ name: "p" }, false, current)).toEqual({ warnings: [] });
    expect(npx.devEngines(undefined, false, current)).toEqual({ warnings: [] });
  });

  test("ends on devEngines it can't read, with npm's words alone", () => {
    for (const [authored, error] of [
      [null, 'Invalid non-object value for "devEngines"'],
      [["x"], 'Invalid non-object value for "devEngines"'],
      [{ foo: {} }, 'Invalid property "devEngines.foo"'],
      [{ runtime: { name: 1 } }, 'Invalid non-string value for "name" within "runtime"'],
      [{ runtime: {} }, 'Missing "name" property for "runtime"'],
      [{ runtime: { name: "node", at: 1 } }, 'Invalid property "at" for "runtime"'],
      [{ libc: { name: "glibc" } }, 'Unable to determine "name" for "libc"'],
      [{ runtime: { name: "node", onFail: "nope" } }, 'Invalid onFail value "nope" for "runtime"'],
      [{ runtime: [[{ name: "node" }]] }, 'Invalid non-object value for "runtime"'],
    ] as const) {
      expect([authored, check(authored)]).toEqual([authored, { warnings: [], error }]);
    }
  });
});

describe("a spec's kind, as npm-package-arg reads it, and allow-git and the rest", () => {
  // Each as npm 11.19.1 named and refused it, under allow-git, allow-remote, allow-file and
  // allow-directory set to none.
  test.each<[string, string, string?]>([
    ["user/repo", "git", "github:user/repo"],
    ["user/repo#main", "git", "github:user/repo#main"],
    ["gist:abc123", "git", "gist:abc123"],
    ["sourcehut:~user/repo", "git", "sourcehut:~user/repo"],
    ["git+https://github.com/user/repo.git", "git", "git+https://github.com/user/repo.git"],
    ["git@github.com:user/repo.git", "git", "git+ssh://git@github.com/user/repo.git"],
    ["git://github.com/user/repo.git", "git", "git://github.com/user/repo.git"],
    ["https://github.com/user/repo", "git", "git+https://github.com/user/repo.git"],
    ["http://github.com/user/repo", "git", "git+ssh://git@github.com/user/repo.git"],
    ["https://gitlab.com/group/sub/repo", "git", "git+https://gitlab.com/group/sub/repo.git"],
    ["ssh://git@github.com/user/repo.git", "git", "git+ssh://git@github.com/user/repo.git"],
    ["git+file:///tmp/repo.git", "git", "git+file:///tmp/repo.git"],
    ["git@example.test:x/y.git", "git", "git+ssh://git@example.test:x/y.git"],
    ["name@user/repo", "git", "name@github:user/repo"],
    ["https://example.test/x.tgz", "remote"],
    ["https://github.com/user/repo/archive/main.tar.gz", "remote"],
    ["name@https://example.test/x.tgz", "remote"],
    ["x.tgz", "file"],
    ["file:x.tgz", "file"],
    ["name@./x.tgz", "file"],
    [".", "directory"],
    ["file:dir", "directory"],
    ["~/dir", "directory"],
    ["a/b/c", "directory"],
    ["c:foo", "directory"],
    [".foo", "directory"],
  ])("%s is a %s spec", (spec, type, saved) => {
    const lines = [`code EALLOW${type.toUpperCase()}`];
    lines.push(`Fetching packages of type "${type}" have been disabled`);
    if (saved !== undefined) lines.push(`Refusing to fetch "${saved}"`);
    const none = { [`allow-${type}`]: "none" };
    expect(npx.refusal([spec], [none], "/work", "/home/me")).toBe(lines.join("\n"));
    expect(npx.refusal([spec], [{ [`allow-${type}`]: "root" }], "/work", "/home/me")).toBe(
      undefined,
    );
    expect(npx.refusal([spec], [{}, { [`allow-${type}`]: "all" }, none], "/work", "/home/me")).toBe(
      undefined,
    );
  });

  test("never refuses a registry's package, an alias, or a spec npm can't read", () => {
    const none = {
      "allow-git": "none",
      "allow-remote": "none",
      "allow-file": "none",
      "allow-directory": "none",
    };
    for (const spec of ["foo", "@s/foo", "foo@^1", "foo@npm:bar", "ftp://example.test/x.tgz"]) {
      expect([spec, npx.refusal([spec], [none], "/work", "/home/me")]).toEqual([spec, undefined]);
    }
  });

  test("names the first refused of several", () => {
    const sources = [{ "allow-file": "none", "allow-remote": "none" }];
    expect(npx.refusal(["foo", "./x", "https://a.test/b.tgz", "x.tgz"], sources, "/w", "/h")).toBe(
      'code EALLOWREMOTE\nFetching packages of type "remote" have been disabled',
    );
  });

  test("gives the folder or tarball a path names, as npm resolves it", () => {
    expect(npx.npmSpec("./a#b/../c d", "/work/x y", "/home/me", "linux")).toEqual({
      type: "directory",
      name: undefined,
      path: "/work/x y/c d",
    });
    expect(npx.npmSpec("@s/n@file:../t.tgz", "/work/x", "/home/me", "linux")).toEqual({
      type: "file",
      name: "@s/n",
      path: "/work/t.tgz",
    });
  });
});

describe("a folder or tarball spec, as npm-package-arg reads it", () => {
  test.each([
    [".", "/cwd/here"],
    ["./x", "/cwd/here/x"],
    ["../x", "/cwd/x"],
    ["/abs/x", "/abs/x"],
    ["~/x", "/home/me/x"],
    ["file:x", "/cwd/here/x"],
    ["file:./x", "/cwd/here/x"],
    ["file:/abs", "/abs"],
    ["file:///abs", "/abs"],
    ["file://abs", "/abs"],
    ["file:/../x", "/cwd/x"],
    ["file:~/x", "/home/me/x"],
    ["a/b/c", "/cwd/here/a/b/c"],
    ["./a%20b", "/cwd/here/a%20b"],
  ])("%s is the folder %s", (spec, folder) => {
    expect(npx.localSpec(spec, "/cwd/here", "/home/me", "linux")).toEqual({
      path: folder,
      tarball: false,
    });
  });

  test("reads a named folder spec's folder", () => {
    expect(npx.localSpec("foo@./x", "/cwd", "/home", "linux")).toEqual({
      path: "/cwd/x",
      tarball: false,
    });
    expect(npx.localSpec("@s/n@file:../y", "/cwd/here", "/home", "linux")).toEqual({
      path: "/cwd/y",
      tarball: false,
    });
  });

  test.each([
    ["x.tgz", "/cwd/here/x.tgz"],
    ["./x.tgz", "/cwd/here/x.tgz"],
    ["file:x.tar", "/cwd/here/x.tar"],
    ["../x.tar.gz", "/cwd/x.tar.gz"],
    ["~/x.tgz", "/home/me/x.tgz"],
  ])("%s is the tarball %s", (spec, file) => {
    expect(npx.localSpec(spec, "/cwd/here", "/home/me", "linux")).toEqual({
      path: file,
      tarball: true,
    });
  });

  test.each([
    "server",
    "@s/n",
    "server@1.2.3",
    "foo@npm:bar",
    "user/repo",
    "user/repo.tgz",
    "git+file:///repo",
    "git@github.com:user/repo.git",
    "https://example.test/x",
    "https://example.test/x.tgz",
  ])("%s isn't a folder or a tarball file", (spec) => {
    expect(npx.localSpec(spec, "/cwd", "/home", "linux")).toBeUndefined();
  });

  test("on Windows, a backslash or a drive makes a path", () => {
    expect(npx.localSpec("a\\b\\c", "/cwd", "/home", "win32")).toBeDefined();
    expect(npx.localSpec("C:\\server", "/cwd", "/home", "win32")).toBeDefined();
    expect(npx.localSpec("a\\b\\c", "/cwd", "/home", "linux")).toBeUndefined();
  });
});

describe("the bins npm reads from a package.json", () => {
  test("name a string bin after the package, unscoped, and clean names and paths", () => {
    expect(npx.binsOf({ name: "@s/tool", bin: "cli.js" }, root)).toEqual({ tool: "cli.js" });
    expect(npx.binsOf({ bin: "cli.js" }, root)).toEqual({});
    expect(npx.binsOf({ name: "x", bin: ["bin/a.js", "b.js"] }, root)).toEqual({
      "a.js": "bin/a.js",
      "b.js": "b.js",
    });
    expect(
      npx.binsOf(
        { name: "x", bin: { "../up": "../../etc/x", "c:d": "d.js", e: 1, "": "f.js" } },
        root,
      ),
    ).toEqual({ up: "etc/x", d: "d.js" });
  });

  test("take every file of directories.bin when there's no bin", () => {
    const dir = tree({ "scripts/a": "", "scripts/sub/b": "", "scripts/.hidden": "" });
    expect(npx.binsOf({ name: "x", directories: { bin: "./scripts" } }, dir)).toEqual({
      a: "scripts/a",
      b: "scripts/sub/b",
    });
    expect(npx.binsOf({ name: "x", bin: "c.js", directories: { bin: "scripts" } }, dir)).toEqual({
      x: "c.js",
    });
  });

  test("never follow a link in directories.bin, as npm's glob doesn't", () => {
    const dir = tree({ "scripts/a": "", "scripts/sub/b": "" });
    // One link back into it: a second would make a walk that follows links run without end.
    symlinkSync("..", join(dir, "scripts", "sub", "up"));
    expect(npx.binsOf({ name: "x", directories: { bin: "scripts" } }, dir)).toEqual({
      a: "scripts/a",
      b: "scripts/sub/b",
    });
  });

  test("pick the one bin, or one file's several names, or the package's own name", () => {
    expect(npx.binOf({ name: "x", bin: { a: "cli.js" } }, root)).toBe("a");
    expect(npx.binOf({ name: "x", bin: { a: "cli.js", b: "./cli.js" } }, root)).toBe("a");
    expect(npx.binOf({ name: "@s/x", bin: { a: "a.js", x: "x.js" } }, root)).toBe("x");
    expect(npx.binOf({ name: "x", bin: { a: "a.js", b: "b.js" } }, root)).toBeUndefined();
    expect(npx.binOf({ name: "x" }, root)).toBeUndefined();
  });
});

describe("npm's local prefix", () => {
  test("is the first folder up with a package.json or a node_modules", () => {
    const base = tree({
      "proj/package.json": "{}",
      "proj/a/b": null,
      "mods/node_modules": null,
      "mods/c": null,
    });
    expect(npx.npmPrefix(join(base, "proj", "a", "b"))).toEqual({
      prefix: join(base, "proj"),
      workspace: undefined,
    });
    expect(npx.npmPrefix(join(base, "mods", "c")).prefix).toBe(join(base, "mods"));
  });

  test("is the workspaces' root for a workspace, which npm then runs in", () => {
    const base = tree({
      "package.json": manifest({ name: "root", workspaces: ["packages/*", "!packages/out"] }),
      "packages/a/package.json": manifest({ name: "a" }),
      "packages/a/src": null,
      "packages/out/package.json": manifest({ name: "out" }),
      "packages/out/src": null,
      "tools/b/package.json": manifest({ name: "b" }),
    });
    expect(npx.npmPrefix(join(base, "packages", "a", "src"))).toEqual({
      prefix: base,
      workspace: join(base, "packages", "a"),
    });
    expect(npx.npmPrefix(join(base, "packages", "out", "src")).workspace).toBeUndefined();
    expect(npx.npmPrefix(join(base, "tools", "b")).workspace).toBeUndefined();
    expect(npx.npmPrefix(base)).toEqual({ prefix: base, workspace: undefined });
  });

  test("reads workspaces' packages form, a later pattern bringing back a negated one", () => {
    const base = tree({
      "package.json": manifest({
        workspaces: { packages: ["packages/*", "!packages/b", "!packages/c", "packages/c"] },
      }),
      "packages/a/package.json": manifest({ name: "a" }),
      "packages/b/package.json": manifest({ name: "b" }),
      "packages/c/package.json": manifest({ name: "c" }),
      "packages/.hidden/package.json": manifest({ name: "hidden" }),
    });
    const workspaceOf = (name: string) => npx.npmPrefix(join(base, "packages", name)).workspace;
    expect(workspaceOf("a")).toBe(join(base, "packages", "a"));
    expect(workspaceOf("b")).toBeUndefined();
    expect(workspaceOf("c")).toBe(join(base, "packages", "c"));
    expect(workspaceOf(".hidden")).toBeUndefined();
  });
});

describe("a local bin, as libnpmexec finds one", () => {
  test("is the first node_modules/.bin from the start up holding a file of that name", () => {
    const base = tree({
      [`node_modules/.bin/${TOOL}`]: "",
      "a/node_modules/.bin": null,
      "a/b": null,
    });
    expect(npx.localBin(join(base, "a", "b"), TOOL)).toBe(join(base, "node_modules", ".bin"));
    const near = tree({ [`node_modules/.bin/${TOOL}`]: "", [`a/node_modules/.bin/${TOOL}`]: "" });
    expect(npx.localBin(join(near, "a"), TOOL)).toBe(join(near, "a", "node_modules", ".bin"));
  });

  test("never a folder, a link to nothing, or a name with an extension it wasn't given", () => {
    const base = tree({
      [`node_modules/.bin/${TOOL}/x`]: "",
      [`node_modules/.bin/${TOOL}-cmd.cmd`]: "",
    });
    symlinkSync(join(base, "missing"), join(base, "node_modules", ".bin", `${TOOL}-dangling`));
    expect(npx.localBin(base, TOOL)).toBeUndefined();
    expect(npx.localBin(base, `${TOOL}-dangling`)).toBeUndefined();
    expect(npx.localBin(base, `${TOOL}-cmd`)).toBeUndefined();
    expect(npx.localBin(base, `${TOOL}-cmd.cmd`)).toBe(join(base, "node_modules", ".bin"));
  });
});

describe("npm's local tree, whose packages npm runs rather than install", () => {
  const base = tree({
    "package.json": manifest({ name: "eidolon-root", workspaces: ["packages/*"] }),
    "packages/a/package.json": manifest({ name: "eidolon-ws-a" }),
    "packages/a/node_modules/eidolon-in-ws/package.json": manifest({ name: "eidolon-in-ws" }),
    "node_modules/eidolon-top/package.json": manifest({ name: "eidolon-top", version: "1.2.0" }),
    "node_modules/eidolon-top/node_modules/eidolon-deep/package.json": manifest({
      name: "eidolon-deep",
    }),
    "node_modules/@s/eidolon-scoped/package.json": manifest({ name: "@s/eidolon-scoped" }),
    // As npm installs eidolon-alias@npm:eidolon-aliased.
    "node_modules/eidolon-alias/package.json": manifest({ name: "eidolon-aliased" }),
    "node_modules/eidolon-pre/package.json": manifest({
      name: "eidolon-pre",
      version: "1.0.0-beta.1",
    }),
    "node_modules/.hidden/package.json": manifest({ name: "eidolon-hidden" }),
  });
  const outside = tree({
    "package.json": manifest({ name: "eidolon-linked" }),
    "node_modules/eidolon-under-link/package.json": manifest({ name: "eidolon-under-link" }),
  });
  symlinkSync(outside, join(base, "node_modules", "eidolon-link"));
  symlinkSync(base, join(base, "node_modules", "eidolon-loop"));
  const packages = npx.treePackages(base);
  const found = (spec: string) => npx.inTree(packages, spec)?.manifest.name;

  test("holds the project, its workspaces and every package below them, a link's too, once", () => {
    const names = packages.map(({ manifest }) => manifest.name);
    expect(names[0]).toBe("eidolon-root");
    expect(names.toSorted()).toEqual([
      "@s/eidolon-scoped",
      "eidolon-aliased",
      "eidolon-deep",
      "eidolon-in-ws",
      "eidolon-linked",
      "eidolon-pre",
      "eidolon-root",
      "eidolon-top",
      "eidolon-under-link",
      "eidolon-ws-a",
    ]);
    expect(names.indexOf("eidolon-top")).toBeLessThan(names.indexOf("eidolon-deep"));
  });

  test("finds a package by its package.json's name, at any depth, the project's own too", () => {
    for (const spec of [
      "eidolon-root",
      "eidolon-ws-a",
      "eidolon-in-ws",
      "eidolon-deep",
      "eidolon-aliased",
      "@s/eidolon-scoped",
      "eidolon-under-link",
    ]) {
      expect([spec, found(spec)]).toEqual([spec, spec]);
    }
    expect(found("eidolon-alias")).toBeUndefined();
    expect(found("eidolon-missing")).toBeUndefined();
  });

  test("finds one at any version for a name alone, or at one the version or range allows", () => {
    for (const spec of [
      "eidolon-top",
      "eidolon-top@",
      "eidolon-top@*",
      "eidolon-top@1.2.0",
      "eidolon-top@^1.0.0",
      "eidolon-top@1.x",
      "eidolon-top@~1.2",
      "eidolon-top@>=1 <2",
      "eidolon-pre",
      "eidolon-pre@1.0.0-beta.1",
    ]) {
      expect([spec, found(spec)]).toEqual([spec, spec.replace(/(?<=.)@.*$/, "")]);
    }
  });

  test("never at a version or range it misses, for a tag, or for an alias", () => {
    for (const spec of [
      "eidolon-top@2.0.0",
      "eidolon-top@^2",
      "eidolon-top@latest",
      "eidolon-top@npm:eidolon-top@1.2.0",
      "eidolon-pre@^1.0.0",
    ]) {
      expect([spec, found(spec)]).toEqual([spec, undefined]);
    }
  });
});

describe("what npx does, as npm decides it", () => {
  // npm's config from a home of its own and no variables, never the developer's.
  const home = tree({});
  const plan = (args: readonly string[], cwd: string, env: Env = {}) =>
    npx.plan(args, cwd, home, env);

  test("runs a bin in a node_modules/.bin above the folder, from the folder", () => {
    const base = tree({ "package.json": "{}", [`node_modules/.bin/${TOOL}`]: "", "sub/dir": null });
    const cwd = join(base, "sub", "dir");
    expect(plan(["-y", TOOL, "a b"], cwd)).toEqual({
      command: TOOL,
      args: ["a b"],
      bins: [join(base, "node_modules", ".bin")],
      runPath: cwd,
    });
  });

  test("runs the project's own bin, linking the project", () => {
    const base = tree({ "package.json": manifest({ name: "self", bin: { [TOOL]: "cli.js" } }) });
    expect(plan([TOOL, "x"], base)).toEqual({
      install: [base],
      command: TOOL,
      args: ["x"],
      bins: [],
      runPath: base,
    });
  });

  test("in a workspace, runs from the workspace, its bins found from there up", () => {
    const base = tree({
      "package.json": manifest({ workspaces: ["packages/*"] }),
      "packages/a/package.json": manifest({ name: "a" }),
      "packages/a/src": null,
      [`node_modules/.bin/${TOOL}`]: "",
    });
    const workspace = join(base, "packages", "a");
    expect(plan([TOOL], join(workspace, "src"))).toEqual({
      command: TOOL,
      args: [],
      bins: [join(base, "node_modules", ".bin")],
      runPath: workspace,
    });
    expect(plan(["-y", "eidolon-elsewhere"], join(workspace, "src"))).toMatchObject({
      install: ["eidolon-elsewhere"],
      runPath: workspace,
    });
  });

  test("runs an installed package's bin, named for it or not; installs what's missing", () => {
    const base = tree({
      "package.json": "{}",
      "node_modules/eidolon-pkg/package.json": manifest({
        name: "eidolon-pkg",
        bin: { "pkg-cli": "cli.js" },
      }),
      "node_modules/eidolon-nobin/package.json": manifest({ name: "eidolon-nobin" }),
    });
    expect(plan(["eidolon-pkg", "x"], base)).toEqual({
      command: "pkg-cli",
      args: ["x"],
      bins: [],
      runPath: base,
    });
    expect(plan(["-p", "eidolon-pkg@1.0.0", "-p", "other", "pkg-cli"], base)).toEqual({
      install: ["other"],
      command: "pkg-cli",
      args: [],
      bins: [],
      runPath: base,
    });
    expect(plan(["-p", "eidolon-pkg", "pkg-cli"], base)).not.toHaveProperty("install");
    expect(plan(["eidolon-nobin"], base)).toEqual({
      error: "could not determine executable to run",
    });
  });

  test("installs nothing npm's tree holds: the project's own name, a nested package, a range", () => {
    const base = tree({
      "package.json": manifest({ name: "eidolon-self", bin: { "self-cli": "cli.js" } }),
      "node_modules/eidolon-top/package.json": manifest({
        name: "eidolon-top",
        version: "1.2.0",
        bin: { "top-cli": "cli.js" },
      }),
      "node_modules/eidolon-top/node_modules/eidolon-deep/package.json": manifest({
        name: "eidolon-deep",
        bin: { "deep-cli": "cli.js" },
      }),
    });
    for (const [args, command] of [
      [["-y", "eidolon-self"], "self-cli"],
      [["-y", "eidolon-deep"], "deep-cli"],
      [["-y", "eidolon-top@^1"], "top-cli"],
    ] as const) {
      expect([args, plan(args, base)]).toEqual([
        args,
        { command, args: [], bins: [], runPath: base },
      ]);
    }
    const both = ["-y", "-p", "eidolon-top@~1.2", "-p", "eidolon-deep", "top-cli"];
    expect(plan(both, base)).not.toHaveProperty("install");
  });

  test("installs anything else, its bin picked once it's there", () => {
    const base = tree({ "package.json": "{}" });
    expect(plan(["-y", "@scope/server@2", "--flag"], base)).toEqual({
      install: ["@scope/server@2"],
      command: undefined,
      args: ["--flag"],
      bins: [],
      runPath: base,
    });
  });

  test("ends as npm does on a folder with no package.json, or a tarball, to read", () => {
    const base = tree({ empty: null });
    const missing = plan(["-y", `file:${join(base, "empty")}`], base);
    expect(missing).toMatchObject({ code: -2 });
    expect("error" in missing && missing.error).toMatch(/^could not read package\.json: ENOENT/);
    const tarball = plan(["-y", "-p", "./missing.tgz", "x"], base);
    expect(tarball).toMatchObject({ code: -2 });
    expect("error" in tarball && tarball.error).toMatch(/^could not read the tarball: ENOENT/);
  });

  test("refuses a package of a kind allow-* is none for, in the local tree or not, as npm does", () => {
    const pkg = manifest({ name: "eidolon-pkg", bin: { "pkg-cli": "cli.js" } });
    const base = tree({
      "package.json": "{}",
      ".npmrc": "allow-directory=none\n",
      "node_modules/eidolon-pkg/package.json": pkg,
      "pkg/package.json": pkg,
    });
    const refused = (type: string, ...more: string[]) => ({
      error: [
        `code EALLOW${type.toUpperCase()}`,
        `Fetching packages of type "${type}" have been disabled`,
        ...more,
      ].join("\n"),
      code: 1,
    });
    // From the .npmrc at npm's local prefix, before the missing folder npm never reads.
    expect(plan(["-y", "-p", "./pkg", "pkg-cli"], base)).toEqual(refused("directory"));
    expect(plan(["-y", "-p", "./missing", "x"], base)).toEqual(refused("directory"));
    expect(plan(["-y", "."], base)).toEqual(refused("directory"));
    // A variable's root over it, which npx's own packages pass.
    expect(plan(["-y", "./pkg"], base, { npm_config_allow_directory: "root" })).toMatchObject({
      install: ["./pkg"],
    });
    expect(plan(["-y", "-p", "x.tgz", "x"], base, { npm_config_allow_file: "none" })).toEqual(
      refused("file"),
    );
    const remote = { npm_config_allow_remote: "none" };
    expect(plan(["-y", "https://example.test/x.tgz"], base, remote)).toEqual(refused("remote"));
    const git = { npm_config_allow_git: "none" };
    expect(plan(["-y", "-p", "eidolon-pkg", "-p", "user/repo", "x"], base, git)).toEqual(
      refused("git", 'Refusing to fetch "github:user/repo"'),
    );
    expect(plan(["-y", "-p", "eidolon-pkg", "x"], base, git)).not.toHaveProperty("error");
  });

  test("never refuses the project's own bin or a local bin, which npm runs as they are", () => {
    const base = tree({
      "package.json": manifest({ name: "self", bin: { [TOOL]: "cli.js" } }),
      ".npmrc": "allow-directory=none\nallow-file=none\n",
      "node_modules/.bin/x.tgz": "",
    });
    expect(plan([TOOL], base)).toMatchObject({ install: [base], command: TOOL });
    expect(plan(["x.tgz", "a"], base)).toEqual({
      command: "x.tgz",
      args: ["a"],
      bins: [join(base, "node_modules", ".bin")],
      runPath: base,
    });
  });

  test("runs nothing under config npm runs no command under, whatever it's asked to run", () => {
    const base = tree({
      "package.json": "{}",
      ".npmrc": "_authToken=t\n",
      [`node_modules/.bin/${TOOL}`]: "",
    });
    const refused = { error: expect.stringMatching(/^code ERR_INVALID_AUTH\n/), code: 1 };
    for (const args of [[TOOL], ["-y", "foo"], ["-c", "x"], []]) {
      expect([args, plan(args, base)]).toEqual([args, refused]);
    }
    // A registry that isn't a URL first.
    expect(plan([TOOL], base, { npm_config_registry: "not a url" })).toEqual({
      error: "code ERR_INVALID_URL\nInvalid URL",
      code: 1,
    });
  });

  test("runs nothing where npm's local prefix has devEngines npm misses, but warns under force", () => {
    const pnpm = { devEngines: { packageManager: { name: "pnpm" } } };
    const base = tree({
      "package.json": JSON.stringify({ workspaces: ["packages/*"], ...pnpm }),
      "packages/a/package.json": manifest({ name: "a" }),
      [`node_modules/.bin/${TOOL}`]: "",
    });
    const refused = { error: expect.stringMatching(/^code EBADDEVENGINES\n/), code: 1 };
    // From a workspace, the root's.
    for (const args of [[TOOL], ["-y", "foo"], []]) {
      expect([args, plan(args, join(base, "packages", "a"))]).toEqual([args, refused]);
    }
    expect(plan([TOOL], base, { npm_config_force: "true" })).toEqual({
      command: TOOL,
      args: [],
      bins: [join(base, "node_modules", ".bin")],
      runPath: base,
      warnings: expect.arrayContaining(["warn EBADDEVENGINES Invalid devEngines.packageManager"]),
    });
    // A workspace's own, npm leaves be, and its config it checks first.
    const own = tree({
      "package.json": manifest({ workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({ name: "a", ...pnpm }),
      ".npmrc": "_auth=a\n",
    });
    expect(plan(["-y", "foo"], join(own, "packages", "a"))).toMatchObject({
      error: expect.stringMatching(/^code ERR_INVALID_AUTH\n/),
    });
    rmSync(join(own, ".npmrc"));
    expect(plan(["-y", "foo"], join(own, "packages", "a"))).toMatchObject({ install: ["foo"] });
  });
});

describe("npm's PATH", () => {
  test("joins each key Windows spells PATH with, in order", () => {
    expect(npx.pathOf({ Path: "a;b", PATH: "b;c", path: "", other: "x" }, ";")).toBe("a;b;c");
  });

  test("is the bins, each node_modules/.bin up from the folder, node-gyp's, the caller's", () => {
    expect(npx.npmPath(["/x/.bin"], "/a/b", "/gyp", "/usr/bin:/bin")).toBe(
      "/x/.bin:/a/b/node_modules/.bin:/a/node_modules/.bin:/node_modules/.bin:/gyp:/usr/bin:/bin",
    );
  });
});

describe("the command's environment", () => {
  test("is the caller's on npm's PATH, set in each key Windows spells it with", () => {
    expect(npx.commandEnv({ Path: "a", PATH: "b", HOME: "/h" }, "x")).toEqual({
      Path: "x",
      PATH: "x",
      HOME: "/h",
    });
    expect(npx.commandEnv({ HOME: "/h" }, "x")).toEqual({ HOME: "/h", PATH: "x" });
  });

  test("leaves out ELECTRON_RUN_AS_NODE, which only what runs on Eidolon's binary needs", () => {
    expect(
      npx.commandEnv({ ELECTRON_RUN_AS_NODE: "1", Electron_Run_As_Node: "0", PATH: "" }, "x"),
    ).toEqual({
      PATH: "x",
    });
  });
});

describe("finding a command", () => {
  test("as sh does: the first executable file on PATH, or a path from the folder", () => {
    const base = tree({
      "a/tool": "",
      "b/tool": "",
      "c/tool": "",
      "c/locked": "",
      "d/tool": null,
      "d/locked": "",
      "here/rel/tool": "",
    });
    for (const file of ["a/tool", "c/locked", "d/locked"]) chmodSync(join(base, file), 0o644);
    const pathEnv = ["a", "d", "b", "c"].map((dir) => join(base, dir)).join(":");
    expect(npx.which("tool", { pathEnv, cwd: base, platform: "linux" })).toBe(
      join(base, "b", "tool"),
    );
    expect(npx.which("rel/tool", { pathEnv, cwd: join(base, "here"), platform: "linux" })).toBe(
      join(base, "here", "rel", "tool"),
    );
    expect(npx.which("nothing", { pathEnv, cwd: base, platform: "linux" })).toBeUndefined();
    // With none executable, the first there, which sh fails to run: Permission denied.
    expect(npx.which("locked", { pathEnv, cwd: base, platform: "linux" })).toBe(
      join(base, "d", "locked"),
    );
  });

  test("as cmd.exe does: each folder through PATHEXT, but not the working folder first", () => {
    const base = tree({
      "a/tool": "",
      "b/tool": "",
      "b/tool.cmd": "",
      "b/tool.exe": "",
      "b/tool.js": "",
      "c d/other.bat": "",
      "here/tool.cmd": "",
      "here/only.cmd": "",
    });
    const options = {
      pathEnv: [join(base, "a"), join(base, "b"), `"${join(base, "c d")}"`].join(";"),
      cwd: join(base, "here"),
      platform: "win32",
    };
    const tool = (extension: string) => join(base, "b", `tool${extension}`);
    expect(npx.which("tool", { ...options, pathext: ".com;.exe;.bat;.cmd" })).toBe(tool(".exe"));
    expect(npx.which("tool", { ...options, pathext: ".cmd;.exe" })).toBe(tool(".cmd"));
    expect(npx.which("tool.js", { ...options, pathext: ".cmd;.exe" })).toBe(tool(".js"));
    expect(npx.which("other", { ...options, pathext: ".bat" })).toBe(
      join(base, "c d", "other.bat"),
    );
    expect(npx.which("only", { ...options, pathext: ".cmd" })).toBeUndefined();
    expect(npx.which("tool", { ...options, pathext: ".bat" })).toBeUndefined();
  });
});

describe("passing signals on", () => {
  const SIGNALS = ["SIGINT", "SIGTERM"] as const;

  /** The listeners `relay` adds for each signal, and what calling them passes on to the child. */
  function relayed(platform: string) {
    const kills: string[] = [];
    const before = SIGNALS.map((signal) => process.listeners(signal).length);
    const undo = npx.relay({ kill: (signal) => kills.push(signal) }, platform);
    const added = SIGNALS.map((signal, at) => process.listeners(signal).slice(before[at]));
    SIGNALS.forEach((signal, at) => {
      for (const listener of added[at] ?? []) (listener as (signal: string) => void)(signal);
    });
    undo();
    expect(SIGNALS.map((signal) => process.listeners(signal).length)).toEqual(before);
    return { listeners: added.map((listeners) => listeners.length), kills };
  }

  test("passes SIGINT and SIGTERM on to the command, as npm does", () => {
    expect(relayed("darwin")).toEqual({ listeners: [1, 1], kills: ["SIGINT", "SIGTERM"] });
  });

  test("on Windows, where kill() is TerminateProcess, passes nothing on, but still waits", () => {
    expect(relayed("win32")).toEqual({ listeners: [1, 1], kills: [] });
  });
});

describe("starting a command", () => {
  test("anything but a Windows batch file or script starts as it is", () => {
    for (const [file, platform] of [
      ["/x/tool", "linux"],
      ["/x/tool.cmd", "darwin"],
      ["C:\\x\\tool.exe", "win32"],
      ["C:\\x\\tool.COM", "win32"],
    ] as const) {
      expect(npx.spawnArgs(file, ["a b", ""], { platform })).toEqual({
        command: file,
        args: ["a b", ""],
        verbatim: false,
      });
    }
  });

  test("a batch file starts through ComSpec's cmd.exe, its words escaped twice", () => {
    expect(
      npx.spawnArgs("C:\\a b\\tool.cmd", ["x y", "&"], {
        platform: "win32",
        env: { comspec: "C:\\cmd.exe" },
      }),
    ).toEqual({
      command: "C:\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\a^ b\\tool.cmd ^^^"x^^^ y^^^" ^^^"^^^&^^^""'],
      verbatim: true,
    });
    expect(npx.spawnArgs("C:\\x\\tool.js", ["&"], { platform: "win32", env: {} })).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\x\\tool.js ^"^&^""'],
      verbatim: true,
    });
  });

  test("escapes a word for cmd.exe as cross-spawn does, a run of backslashes doubled whole", () => {
    expect(cross.escapeArgument("", false)).toBe('^"^"');
    expect(cross.escapeArgument('q"x', false)).toBe('^"q\\^"x^"');
    expect(cross.escapeArgument("C:\\dir\\", false)).toBe('^"C:\\dir\\\\^"');
    expect(cross.escapeArgument('a\\"b', false)).toBe('^"a\\\\\\^"b^"');
    expect(cross.escapeArgument("C:\\dir\\\\", false)).toBe('^"C:\\dir\\\\\\\\^"');
    expect(cross.escapeArgument('a\\\\"b\\\\\\', false)).toBe('^"a\\\\\\\\\\^"b\\\\\\\\\\\\^"');
    expect(cross.escapeArgument("100%!^<>|", false)).toBe('^"100^%^!^^^<^>^|^"');
    expect(cross.escapeArgument("&", true)).toBe('^^^"^^^&^^^"');
    expect(cross.escapeCommand("C:\\Program Files (x86)\\x.cmd")).toBe(
      "C:\\Program^ Files^ ^(x86^)\\x.cmd",
    );
  });
});
