// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/test/stdio.test.ts@ac78a60
//
// The fixtures run on this Bun, as pi's run on its Node; every process a case starts is killed
// before it ends.
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { McpClient } from "../src/mcp/client.ts";
import { StdioTransport } from "../src/mcp/transports/stdio.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = join(FIXTURES, "mcp-stdio-server.mjs");
const stubborn = join(FIXTURES, "mcp-stubborn-server.mjs");
const exitingParent = join(FIXTURES, "mcp-exiting-parent-server.mjs");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

describe("StdioTransport", () => {
  it("connects to a newline-delimited MCP server and captures stderr", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: ["--no-env-file", fixture],
    });
    const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
    expect(await client.callTool("echo", { text: "hello" })).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
    expect(transport.pid).toBeTypeOf("number");
    expect(await waitFor(() => transport.stderr.includes("stdio fixture ready"))).toBe(true);
    await client.close();
    expect(client.connectionState).toBe("closed");
  });

  it("kills a server that ignores shutdown, including its children", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: ["--no-env-file", stubborn],
      closeTimeoutMs: 100,
    });
    const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    let grandchild: number | undefined;
    await waitFor(() => {
      const match = /grandchild (\d+)/.exec(transport.stderr);
      if (match) grandchild = Number(match[1]);
      return grandchild !== undefined;
    });
    expect(grandchild).toBeTypeOf("number");

    const startedAt = Date.now();
    await client.close();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(await waitFor(() => !isAlive(grandchild as number))).toBe(true);
  }, 10_000);

  it("kills children still holding the pipes after the server process exited", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: ["--no-env-file", exitingParent],
      closeTimeoutMs: 100,
    });
    let closeEvents = 0;
    transport.onClose(() => closeEvents++);
    await transport.start();
    const serverPid = transport.pid as number;
    let helper: number | undefined;
    await waitFor(() => {
      const match = /helper (\d+)/.exec(transport.stderr);
      if (match) helper = Number(match[1]);
      return helper !== undefined;
    });
    expect(helper).toBeTypeOf("number");
    expect(await waitFor(() => !isAlive(serverPid))).toBe(true);
    try {
      expect(isAlive(helper as number)).toBe(true);

      await transport.close();
      expect(await waitFor(() => !isAlive(helper as number))).toBe(true);
      expect(closeEvents).toBe(1);
    } finally {
      try {
        process.kill(helper as number, "SIGKILL");
      } catch {}
    }
  }, 10_000);

  it("gives the server the environment it is given and nothing of this process's", async () => {
    process.env.EIDOLON_MCP_STDIO_PROBE = "leaked";
    const transport = new StdioTransport({
      command: process.execPath,
      args: [
        "--no-env-file",
        "-e",
        "console.error(JSON.stringify(Object.keys(process.env).filter((key) => key.startsWith('EIDOLON_MCP'))))",
      ],
      env: { EIDOLON_MCP_GIVEN: "1" },
    });
    try {
      await transport.start();
      expect(await waitFor(() => transport.stderr.includes("]"))).toBe(true);
      expect(JSON.parse(transport.stderr)).toEqual(["EIDOLON_MCP_GIVEN"]);
    } finally {
      delete process.env.EIDOLON_MCP_STDIO_PROBE;
      await transport.close();
    }
  });
});
