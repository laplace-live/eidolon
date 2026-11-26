// The launcher's pure parts: what each command line runs, which hosts and Nodes it refuses, and the
// environment the app gets.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "@eidolon/cli";
import { describe, expect, test } from "vitest";
import {
  CLI_COMMANDS,
  childEnv,
  type Host,
  hasVcRuntime,
  NODE_MAJOR,
  parseCommand,
  unsupportedNode,
  unsupportedReason,
  usage,
  VC_RUNTIME_DLLS,
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
    vcRuntime: true,
    ...extra,
  });

  test("Apple silicon, glibc Linux on x64 or arm64, and Windows on x64 are supported", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["linux", "x64"],
      ["linux", "arm64"],
      ["win32", "x64"],
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
    expect(unsupportedReason(host("win32", "x64", { vcRuntime: false }))).toContain(
      "https://aka.ms/vs/17/release/vc_redist.x64.exe",
    );
    expect(unsupportedReason(host("win32", "arm64"))).toContain("Install the x64 build of Node");
    expect(unsupportedReason(host("win32", "ia32"))).toStartWith("win32-ia32 is not supported");
    expect(unsupportedReason(host("linux", "ia32"))).toStartWith("linux-ia32 is not supported");
    expect(unsupportedReason(host("freebsd", "arm64"))).toContain("Zvec and onnxruntime-node");
  });
});

describe("hasVcRuntime", () => {
  test("finds each DLL in System32 or a PATH folder, as Windows looks for one", () => {
    const work = mkdtempSync(join(tmpdir(), "eidolon-vc-runtime-"));
    try {
      const [system, tools] = [join(work, "Windows"), join(work, "tools")];
      mkdirSync(join(system, "System32"), { recursive: true });
      mkdirSync(tools);
      const [first, ...rest] = VC_RUNTIME_DLLS as [string, ...string[]];
      for (const dll of rest) writeFileSync(join(system, "System32", dll), "");
      expect(hasVcRuntime({ SystemRoot: system, PATH: "" })).toBe(false);
      writeFileSync(join(tools, first), "");
      expect(hasVcRuntime({ SystemRoot: system, PATH: `;${tools};` })).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("unsupportedNode", () => {
  test(`Node ${NODE_MAJOR} and later run the bundles`, () => {
    for (const version of [`${NODE_MAJOR}.0.0`, "24.22.1", "26.1.0"]) {
      expect(unsupportedNode(version)).toBeNull();
    }
  });

  test("an older Node is told which one to install", () => {
    expect(unsupportedNode("22.12.0")).toBe(
      "this is Node.js 22.12.0, and Eidolon needs Node.js 24 or later. Install a newer Node, " +
        "then run eidolon again.",
    );
    expect(unsupportedNode("20.19.5")).toContain("needs Node.js 24 or later");
  });
});

describe("childEnv", () => {
  test("names the package and skips every .env, leaving the rest as it was", () => {
    const env = { PATH: "/bin", NODE_OPTIONS: "--max-old-space-size=4096" };
    expect(childEnv(env, "/opt/my pkg")).toEqual({
      PATH: "/bin",
      NODE_OPTIONS: "--max-old-space-size=4096",
      EIDOLON_APP_ROOT: "/opt/my pkg",
      EIDOLON_NO_DOTENV: "1",
    });
    expect(env).toEqual({ PATH: "/bin", NODE_OPTIONS: "--max-old-space-size=4096" });
  });
});
