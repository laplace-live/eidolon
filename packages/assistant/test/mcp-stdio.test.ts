// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
//
// Ported from pi-mono packages/mcp/test/stdio.test.ts@ac78a60
//
// The fixtures run on this Node, as pi's do; every process a case starts is killed before it ends.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { McpClient } from "../src/mcp/client.ts";
import { StdioTransport } from "../src/mcp/transports/stdio.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = join(FIXTURES, "mcp-stdio-server.mjs");
const stubborn = join(FIXTURES, "mcp-stubborn-server.mjs");
const exitingParent = join(FIXTURES, "mcp-exiting-parent-server.mjs");
const daemon = join(FIXTURES, "mcp-daemon-server.mjs");
const leftover = join(FIXTURES, "mcp-leftover-server.mjs");
const STDIO = join(import.meta.dirname, "../src/mcp/transports/stdio.ts");

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

/**
 * The pids `body` returns, run in a process of its own with StdioTransport imported, once that
 * process has ended by process.exit, as the app's shutdown ends it.
 */
function pidsAfterExit(body: string): number[] {
  const host = spawnSync(
    process.execPath,
    [
      "-e",
      `const { StdioTransport } = await import(${JSON.stringify(STDIO)});
      const pids = await (async () => { ${body} })();
      process.stdout.write(JSON.stringify(pids), () => process.exit(0));`,
    ],
    { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" },
  );
  return JSON.parse(host.stdout) as number[];
}

function killAll(pids: readonly number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

describe("StdioTransport", () => {
  it("connects to a newline-delimited MCP server and captures stderr", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [fixture],
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
      args: [stubborn],
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
      args: [exitingParent],
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

  it("lets go of the pipes a process outside the server's group holds, so close() still ends", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [daemon],
      closeTimeoutMs: 100,
    });
    const client = new McpClient({ name: "stdio-test", version: "1.0.0" });
    await client.connect(transport);
    let helper: number | undefined;
    await waitFor(() => {
      const match = /helper (\d+)/.exec(transport.stderr);
      if (match) helper = Number(match[1]);
      return helper !== undefined;
    });
    try {
      const closed = client.close().then(() => "closed");
      expect(await Promise.race([closed, delay(4_000).then(() => "pending")])).toBe("closed");
      // It left the group, so no close reaches it.
      expect(isAlive(helper as number)).toBe(true);
    } finally {
      try {
        process.kill(helper as number, "SIGKILL");
      } catch {}
    }
  }, 10_000);

  it("kills what a server that exits on its stdin closing leaves in its group, SIGTERM or not", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: [leftover],
      closeTimeoutMs: 100,
    });
    await transport.start();
    let helper: number | undefined;
    await waitFor(() => {
      const match = /helper (\d+)/.exec(transport.stderr);
      if (match) helper = Number(match[1]);
      return helper !== undefined;
    });
    expect(helper).toBeTypeOf("number");
    try {
      await transport.close();
      expect(await waitFor(() => !isAlive(helper as number))).toBe(true);
    } finally {
      killAll([helper as number]);
    }
  }, 10_000);

  it("kills a server that ignores SIGTERM, and its children, when the host exits without closing it", async () => {
    const pids = pidsAfterExit(`
      const transport = new StdioTransport({
        command: process.execPath,
        args: [${JSON.stringify(stubborn)}],
      });
      await transport.start();
      while (!/grandchild \\d+/.test(transport.stderr)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return [transport.pid, Number(/grandchild (\\d+)/.exec(transport.stderr)[1])];
    `);
    try {
      expect(pids).toHaveLength(2);
      expect(await waitFor(() => !pids.some(isAlive))).toBe(true);
    } finally {
      killAll(pids);
    }
  }, 10_000);

  it("kills what an exited server left in its group when the host exits before its SIGKILL is due", async () => {
    const pids = pidsAfterExit(`
      const transport = new StdioTransport({
        command: process.execPath,
        args: [${JSON.stringify(leftover)}, "--exit"],
        closeTimeoutMs: 60_000,
      });
      const closed = new Promise((resolve) => transport.onClose(resolve));
      await transport.start();
      await closed;
      return [Number(/helper (\\d+)/.exec(transport.stderr)[1])];
    `);
    try {
      expect(pids).toHaveLength(1);
      expect(await waitFor(() => !pids.some(isAlive))).toBe(true);
    } finally {
      killAll(pids);
    }
  }, 10_000);

  it.runIf(process.platform === "win32")(
    "on Windows starts a .cmd server by its bare name, as npx is, and closing kills its tree",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "eidolon-mcp-cmd-"));
      const script = join(dir, "server.mjs");
      writeFileSync(
        script,
        `import { spawn } from "node:child_process";
        const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        console.error(JSON.stringify({ argv: process.argv.slice(2), grandchild: grandchild.pid }));
        setInterval(() => {}, 1000);`,
      );
      writeFileSync(join(dir, "fixture-server.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
      const args = ["a b", "x&y", "(1)", "100%", "^caret", "C:\\Program Files (x86)\\x"];
      const transport = new StdioTransport({
        command: "fixture-server",
        args,
        env: { PATH: `${dir};${process.env.PATH ?? ""}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        closeTimeoutMs: 100,
      });
      try {
        await transport.start();
        expect(await waitFor(() => transport.stderr.includes("}"), 10_000)).toBe(true);
        const said = JSON.parse(transport.stderr) as { argv: string[]; grandchild: number };
        expect(said.argv).toEqual(args);
        await transport.close();
        expect(await waitFor(() => !isAlive(said.grandchild), 5_000)).toBe(true);
      } finally {
        await transport.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("gives the server the environment it is given and nothing of this process's", async () => {
    process.env.EIDOLON_MCP_STDIO_PROBE = "leaked";
    const transport = new StdioTransport({
      command: process.execPath,
      args: [
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
