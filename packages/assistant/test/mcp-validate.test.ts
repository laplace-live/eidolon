// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/test/config.test.ts@ac78a60
//
// pi's cases for stdio entries and fields every entry has; an HTTP entry is refused here, with the
// way to reach it as a stdio one.
import { describe, expect, it } from "bun:test";
import {
  HTTP_SERVERS_LATER,
  type McpServerConfigResult,
  validateMcpServerConfig,
} from "../src/mcp/config.ts";

/** The error of an invalid entry, or the empty string. */
function errorOf(result: McpServerConfigResult): string {
  return result.kind === "invalid" ? result.error : "";
}

describe("validateMcpServerConfig", () => {
  it("accepts stdio entries and keeps them as given", () => {
    const stdio = {
      command: "npx",
      args: ["-y", "server"],
      env: { A: "1" },
      cwd: "/srv",
      enabled: false,
      timeout: 30,
      description: "Docs",
    };
    const result = validateMcpServerConfig("files", stdio);
    expect(result).toEqual({ kind: "stdio", config: stdio });
    if (result.kind === "stdio") expect(result.config).toBe(stdio);
    expect(validateMcpServerConfig("files", { type: "stdio", command: "x" }).kind).toBe("stdio");
  });

  it("refuses an HTTP entry, by its url or its type, with the way to reach it as a stdio one", () => {
    const http = `server "docs": ${HTTP_SERVERS_LATER}`;
    expect(errorOf(validateMcpServerConfig("docs", { url: "https://example.com/mcp" }))).toBe(http);
    // With both, url wins unless the type says stdio.
    expect(
      errorOf(validateMcpServerConfig("docs", { url: "https://a.example", command: "x" })),
    ).toBe(http);
    for (const type of ["http", "streamable-http", "sse"]) {
      expect(errorOf(validateMcpServerConfig("docs", { type, url: "https://a.example" }))).toBe(
        http,
      );
    }
    expect(
      validateMcpServerConfig("docs", { type: "stdio", url: "https://a.example", command: "x" })
        .kind,
    ).toBe("stdio");
    expect(HTTP_SERVERS_LATER).toBe("HTTP servers come later: run it through mcp-remote");
  });

  it("reports invalid names and fields", () => {
    const cases: [string, unknown, string][] = [
      [
        "bad name",
        { command: "x" },
        'invalid server name "bad name" (use letters, digits, "_" and "-")',
      ],
      ["s", "npx", 'server "s" must be an object'],
      ["s", [], 'server "s" must be an object'],
      ["s", { command: "x", enabled: "yes" }, 'server "s": enabled must be a boolean'],
      ["s", { command: "x", description: 1 }, 'server "s": description must be a string'],
      [
        "s",
        { command: "x", timeout: 0 },
        'server "s": timeout must be a positive number of seconds',
      ],
      ["s", { command: "x", args: "a b" }, 'server "s": args must be an array of strings'],
      ["s", { command: "x", env: { A: 1 } }, 'server "s": env must map names to strings'],
      ["s", { command: "x", cwd: 1 }, 'server "s": cwd must be a string'],
      ["s", {}, 'server "s" needs a "command" to run'],
    ];
    for (const [name, raw, error] of cases) {
      expect(errorOf(validateMcpServerConfig(name, raw))).toBe(error);
    }
  });
});

describe("extending validateMcpServerConfig", () => {
  /** An application's own fields, like p2's `shared`, checked on the result. */
  function validateAppConfig(name: string, raw: unknown): string {
    const result = validateMcpServerConfig(name, raw);
    if (result.kind === "invalid") return result.error;
    const { shared } = result.config;
    if (shared !== undefined && typeof shared !== "boolean") {
      return `server "${name}": shared must be a boolean`;
    }
    return `${result.kind} shared=${String(shared)}`;
  }

  it("keeps unknown fields for the caller, after the shared fields are valid", () => {
    expect(validateAppConfig("s", { command: "x", shared: true })).toBe("stdio shared=true");
    expect(validateAppConfig("s", { command: "x", shared: 1 })).toBe(
      'server "s": shared must be a boolean',
    );
    // The shared fields are reported first.
    expect(validateAppConfig("s", { command: "x", shared: 1, enabled: "no" })).toBe(
      'server "s": enabled must be a boolean',
    );
  });
});
