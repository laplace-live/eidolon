// The desktop app's node shim in a server's environment: serverEnv with a made-up shim, nodeShim on
// this runtime, and on Electron's Node (test-on-electron.ts) servers started as `node` and as `npx`
// through the checkout's launchers, on a PATH where only they offer either.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { delimiter, join } from "node:path";
import { PROJECT_ROOT } from "@eidolon/config";
import { afterEach, describe, expect, test } from "vitest";
import { parseMcpConfig } from "../src/mcp/servers.ts";
import { McpSession, nodeShim, serverEnv } from "../src/mcp/session.ts";
import { shellEnv } from "../src/tools/shell.ts";
import { folderGuard, removeTempFolders, tempFolder, toolContext } from "./tool-folder.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/mcp-server.ts");
const ELECTRON = process.versions.electron !== undefined;
const SOURCES = join(PROJECT_ROOT, "apps", "desktop", "node-shim");

const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  delete process.env.EIDOLON_APP_ROOT;
  await removeTempFolders();
});

describe("a server's environment", () => {
  // The desktop app's backend runs with ELECTRON_RUN_AS_NODE, which only a launcher may pass on.
  const from = {
    PATH: ["/usr/bin", "/bin"].join(delimiter),
    HOME: "/home/owner",
    KEY: "secret",
    ELECTRON_RUN_AS_NODE: "1",
  };

  test("is the task's cut one when there's no shim", async () => {
    const guard = folderGuard(await tempFolder());
    expect(await serverEnv(guard, null, from)).toEqual(await shellEnv(guard, from));
  });

  // The payload's launchers are in a node_modules/.bin, which the cut drops from any PATH.
  const PAYLOAD = "/Applications/Eidolon.app/Contents/Resources/eidolon";
  const shim = {
    folder: `${PAYLOAD}/node-shim/node_modules/.bin`,
    node: "/Applications/Eidolon.app/x",
  };

  test("has the shim's folder last on PATH and EIDOLON_NODE, the binary its launchers run, but not the backend's ELECTRON_RUN_AS_NODE", async () => {
    const guard = folderGuard(await tempFolder());
    expect(await serverEnv(guard, shim, from)).toEqual({
      HOME: "/home/owner",
      PATH: ["/usr/bin", "/bin", shim.folder].join(delimiter),
      TERM: "dumb",
      EIDOLON_NODE: shim.node,
    });
    // On PATH already, it is still cut where it was and comes last.
    const listed = { ...from, PATH: [shim.folder, from.PATH].join(delimiter) };
    expect((await serverEnv(guard, shim, listed)).PATH).toBe(
      ["/usr/bin", "/bin", shim.folder].join(delimiter),
    );
  });

  test("leaves the shim off PATH where the task may write it, as any other folder", async () => {
    const folder = await tempFolder();
    const writable = {
      folder: join(folder, "node-shim", "node_modules", ".bin"),
      node: "/eidolon",
    };
    expect((await serverEnv(folderGuard(folder), writable, from)).PATH).toBe(from.PATH);
  });

  test("never reaches a task's commands, which run on the cut environment alone", async () => {
    const guard = folderGuard(await tempFolder());
    const listed = { ...from, PATH: [from.PATH, shim.folder].join(delimiter) };
    expect(await shellEnv(guard, listed)).toEqual({
      HOME: "/home/owner",
      PATH: from.PATH,
      TERM: "dumb",
    });
  });
});

describe("the node shim", () => {
  /** An EIDOLON_APP_ROOT, with the shim's folder or without it. */
  async function appRoot(withShim: boolean): Promise<string> {
    const root = await tempFolder();
    if (withShim) await mkdir(join(root, "node-shim", "node_modules", ".bin"), { recursive: true });
    return root;
  }

  test.skipIf(ELECTRON)("is none under Node, wherever the app's files are", async () => {
    expect(nodeShim()).toBeNull();
    process.env.EIDOLON_APP_ROOT = await appRoot(true);
    expect(nodeShim()).toBeNull();
  });

  test.skipIf(!ELECTRON)(
    "on Electron's Node is the payload's, or without one the checkout's sources, run on this binary",
    async () => {
      expect(nodeShim()).toEqual({ folder: SOURCES, node: process.execPath });
      const root = await appRoot(true);
      process.env.EIDOLON_APP_ROOT = root;
      expect(nodeShim()).toEqual({
        folder: join(root, "node-shim", "node_modules", ".bin"),
        node: process.execPath,
      });
      process.env.EIDOLON_APP_ROOT = await appRoot(false);
      expect(nodeShim()).toBeNull();
    },
  );
});

describe.skipIf(!ELECTRON || process.platform === "win32")(
  "a server on Electron's Node, where the computer has no node",
  () => {
    async function open(server: Record<string, unknown>): Promise<McpSession> {
      const before = process.env.PATH;
      const home = await tempFolder();
      process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
      try {
        const session = await McpSession.open({
          config: parseMcpConfig(JSON.stringify({ mcpServers: { fake: server } }), "mcp.json"),
          secrets: {},
          cwd: join(home, "mcp"),
          guard: folderGuard(await tempFolder()),
          version: "test",
          signal: new AbortController().signal,
        });
        sessions.push(session);
        return session;
      } finally {
        process.env.PATH = before;
      }
    }

    async function serverValues(session: McpSession): Promise<Record<string, string | null>> {
      expect(session.failed).toEqual([]);
      const tool = session.tools.find((each) => each.schema.name === "mcp__fake__env");
      if (tool === undefined) throw new Error("the server listed no env tool");
      const values = ["ELECTRON_RUN_AS_NODE", "EIDOLON_NODE"];
      return JSON.parse((await tool.execute({ values }, toolContext())).content).values;
    }

    test("one run as node starts on the shim's launcher", async () => {
      const session = await open({ command: "node", args: [FIXTURE] });
      expect(await serverValues(session)).toEqual({
        ELECTRON_RUN_AS_NODE: "1",
        EIDOLON_NODE: process.execPath,
      });
    });

    // pnpm dlx copies the package into a store of its own on the first run.
    test("one run as npx starts through the bundled pnpm, with stdout left to the protocol", {
      timeout: 60_000,
    }, async () => {
      const pkg = await tempFolder();
      const home = await tempFolder();
      const server = join(pkg, "server.mjs");
      await writeFile(
        join(pkg, "package.json"),
        JSON.stringify({ name: "eidolon-fake-mcp", version: "1.0.0", bin: "server.mjs" }),
      );
      // Installed into dlx's node_modules, where Node refuses to strip types from .ts.
      const js = stripTypeScriptTypes(await readFile(FIXTURE, "utf8"));
      await writeFile(server, `#!/usr/bin/env node\n${js}`);
      await chmod(server, 0o755);
      const session = await open({
        command: "npx",
        args: ["-y", `file:${pkg}`],
        env: { HOME: home },
      });
      expect(await serverValues(session)).toEqual({
        ELECTRON_RUN_AS_NODE: "1",
        EIDOLON_NODE: process.execPath,
      });
    });
  },
);
