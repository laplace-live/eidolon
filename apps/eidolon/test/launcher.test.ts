// The launcher's pure parts: what each command line runs, which hosts it refuses, where it finds
// Bun, and the environment Bun gets, checked against a real Bun for the bunfig.toml it reads.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "@eidolon/cli";
import {
  type BunLookup,
  CLI_COMMANDS,
  childEnv,
  findBun,
  type Host,
  parseCommand,
  unsupportedReason,
  usage,
} from "../src/launcher.ts";

describe("parseCommand", () => {
  test("no arguments, app or a flag runs the web app with the rest", () => {
    expect(parseCommand([])).toEqual({ kind: "app", args: [] });
    expect(parseCommand(["app", "--port", "0"])).toEqual({ kind: "app", args: ["--port", "0"] });
    expect(parseCommand(["--no-open", "-v"])).toEqual({ kind: "app", args: ["--no-open", "-v"] });
    expect(parseCommand(["app", "--help"])).toEqual({ kind: "app", args: ["--help"] });
  });

  test("a CLI command runs the CLI with its name", () => {
    expect(parseCommand(["search", "--help"])).toEqual({ kind: "cli", args: ["search", "--help"] });
    expect(parseCommand(["pipeline", "--dry-run"])).toEqual({
      kind: "cli",
      args: ["pipeline", "--dry-run"],
    });
  });

  test("help, the version, and what isn't a command", () => {
    expect(parseCommand(["-h"])).toEqual({ kind: "help" });
    expect(parseCommand(["--help", "search"])).toEqual({ kind: "help" });
    expect(parseCommand(["--version"])).toEqual({ kind: "version" });
    expect(parseCommand(["serve"])).toEqual({ kind: "unknown", name: "serve" });
    expect(parseCommand(["gate-decisions"])).toEqual({ kind: "unknown", name: "gate-decisions" });
  });

  test("every CLI command ships but gate-decisions, and the help lists each", () => {
    expect([...CLI_COMMANDS].sort()).toEqual(
      Object.keys(COMMANDS)
        .filter((name) => name !== "gate-decisions")
        .sort(),
    );
    const help = usage("1.2.3");
    for (const name of CLI_COMMANDS) expect(help).toContain(name);
    expect(help).toContain("Eidolon 1.2.3");
    expect(help).not.toContain("gate-decisions");
    expect(Math.max(...help.split("\n").map((line) => line.length))).toBeLessThanOrEqual(100);
  });
});

describe("unsupportedReason", () => {
  const host = (platform: string, arch: string, extra: Partial<Host> = {}): Host => ({
    platform,
    arch,
    glibc: platform === "linux",
    rosetta: false,
    ...extra,
  });

  test("Apple silicon, and glibc Linux on x64 or arm64, are supported", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["linux", "x64"],
      ["linux", "arm64"],
    ] as const) {
      expect(unsupportedReason(host(platform, arch))).toBeNull();
    }
  });

  test("each other host is told why", () => {
    expect(unsupportedReason(host("darwin", "x64", { rosetta: true }))).toContain(
      "Install the arm64 build of Node",
    );
    expect(unsupportedReason(host("darwin", "x64"))).toStartWith("Intel Macs are not supported");
    expect(unsupportedReason(host("linux", "x64", { glibc: false }))).toStartWith(
      "Linux with musl",
    );
    expect(unsupportedReason(host("win32", "x64"))).toStartWith("win32-x64 is not supported");
    expect(unsupportedReason(host("linux", "ia32"))).toStartWith("linux-ia32 is not supported");
    expect(unsupportedReason(host("freebsd", "arm64"))).toContain("LanceDB and onnxruntime-node");
  });
});

describe("findBun", () => {
  const OWN = "/pkg/node_modules/@oven/bun-darwin-aarch64/bin/bun";
  const BUN = "/project/node_modules/bun";

  function lookup(files: Record<string, number>, versions: Record<string, string> = {}): BunLookup {
    return {
      override: undefined,
      resolve: (specifier) =>
        specifier === "@oven/bun-darwin-aarch64/bin/bun" && OWN in files
          ? OWN
          : specifier === "bun/package.json" && `${BUN}/package.json` in versions
            ? `${BUN}/package.json`
            : null,
      size: (path) => files[path] ?? null,
      version: (path) => versions[path] ?? null,
    };
  }

  test("takes the platform package's binary", () => {
    expect(findBun("darwin-arm64", "1.4.4", lookup({ [OWN]: 88_000_000 }))).toBe(OWN);
  });

  test("EIDOLON_BUN wins", () => {
    const found = findBun("darwin-arm64", "1.4.4", {
      ...lookup({ [OWN]: 88_000_000 }),
      override: "/opt/bun",
    });
    expect(found).toBe("/opt/bun");
  });

  test("finds the binary bun's postinstall moved, at this version only", () => {
    const moved = { [`${BUN}/bin/bun.exe`]: 88_000_000 };
    expect(
      findBun("darwin-arm64", "1.4.4", lookup(moved, { [`${BUN}/package.json`]: "1.4.4" })),
    ).toBe(`${BUN}/bin/bun.exe`);
    expect(
      findBun("darwin-arm64", "1.4.4", lookup(moved, { [`${BUN}/package.json`]: "1.3.0" })),
    ).toBeNull();
  });

  test("never bun's placeholder script, and null when nothing is installed", () => {
    const placeholder = { [`${BUN}/bin/bun.exe`]: 450 };
    expect(
      findBun("darwin-arm64", "1.4.4", lookup(placeholder, { [`${BUN}/package.json`]: "1.4.4" })),
    ).toBeNull();
    expect(findBun("darwin-arm64", "1.4.4", lookup({}))).toBeNull();
  });
});

describe("childEnv", () => {
  test("names the package, skips every .env, and leads BUN_OPTIONS with the package's bunfig", () => {
    const env = { PATH: "/bin", BUN_OPTIONS: "--smol" };
    expect(childEnv(env, "/opt/my pkg")).toEqual({
      PATH: "/bin",
      EIDOLON_APP_ROOT: "/opt/my pkg",
      EIDOLON_NO_DOTENV: "1",
      BUN_OPTIONS: '"--config=/opt/my pkg/bunfig.toml" --smol',
    });
    expect(env).toEqual({ PATH: "/bin", BUN_OPTIONS: "--smol" });
    expect(childEnv({}, "/opt/pkg").BUN_OPTIONS).toBe('"--config=/opt/pkg/bunfig.toml"');
  });

  test("keeps the working directory's bunfig.toml and .env out of Bun, and of every Bun it starts", () => {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-launcher-"));
    try {
      const cwd = join(dir, "cwd");
      const root = join(dir, "the package");
      mkdirSync(cwd);
      mkdirSync(root);
      writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./hijack.ts"]\n');
      writeFileSync(join(cwd, "hijack.ts"), 'console.log("hijacked");\n');
      writeFileSync(join(cwd, ".env"), "EIDOLON_DOTENV_PROBE=read\n");
      writeFileSync(join(root, "bunfig.toml"), "env = false\n");
      const probe = 'process.env.EIDOLON_DOTENV_PROBE ?? "clean"';
      writeFileSync(join(root, "child.ts"), `console.log("child", ${probe});\n`);
      writeFileSync(
        join(root, "main.ts"),
        `console.log("main", ${probe});\n` +
          'Bun.spawnSync([process.execPath, import.meta.dir + "/child.ts"], { stdout: "inherit" });\n',
      );
      const env = childEnv({ PATH: process.env.PATH }, root);
      const run = Bun.spawnSync([process.execPath, join(root, "main.ts")], { cwd, env });
      expect(run.stdout.toString()).toBe("main clean\nchild clean\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
