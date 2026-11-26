// /api/local/mcp over a manager, as the local router serves it: what Settings is shown of mcp.json,
// what a PUT may change there and what it refuses, and an MCP card's answer as the page sends it.
// The booted server's guard is in tasks-server.test.ts.
import "../../../../packages/config/test/isolated-guard.ts";
import {
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type TaskSnapshot, tasksDir } from "@eidolon/assistant";
import { type AssistantSettings, dataHome, jsRuntime, newId } from "@eidolon/config";
import type { createMind, MindChunk } from "@eidolon/engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { RouteHandler } from "../../src/app.ts";
import type { ErrorBody, McpServersResponse } from "../../src/local/api.ts";
import { createLocalRouter } from "../../src/local/router.ts";
import { mcpRoutes } from "../../src/local/routes/mcp.ts";
import { tasksRoutes } from "../../src/local/routes/tasks.ts";
import { TaskManager } from "../../src/local/tasks/manager.ts";
import { ensureDataHome } from "../../src/local/write.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type ServedRoutes, serveRoutes } from "../serve.ts";

const FIXTURE = join(
  import.meta.dirname,
  "../../../../packages/assistant/test/fixtures/mcp-server.ts",
);
const AUTH = "Bearer test-secret";

let work = "";
let umask = 0;
let settings: AssistantSettings;
let logs: CapturedLogs;
const managers: TaskManager[] = [];
const servers: Promise<ServedRoutes>[] = [];
const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`unexpected network call in a test: ${String(input)}`);
  }) as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  // So a mode the code asks for shows: a umask of 077 makes every file 0600 whatever it asks.
  umask = process.umask(0o022);
  ensureDataHome();
  work = mkdtempSync(join(tmpdir(), "eidolon-mcp-routes-"));
  settings = {
    enabled: true,
    folders: [work],
    bash: true,
    spendPauseUsd: 1,
    contextTokens: 128_000,
    permissions: "ask",
  };
  logs = captureLogs();
  setEnv("ASSISTANT_PROVIDER", "openrouter");
  setEnv("ASSISTANT_MODEL", "test/model");
});

afterEach(async () => {
  for (const server of servers.splice(0)) await (await server).stop();
  for (const tasks of managers.splice(0)) await tasks.stop();
  process.umask(umask);
  logs.restore();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  rmSync(work, { recursive: true, force: true });
  rmSync(tasksDir(), { recursive: true, force: true });
  rmSync(join(dataHome(), "locks"), { recursive: true, force: true });
  rmSync(join(dataHome(), "mcp"), { recursive: true, force: true });
  rmSync(join(dataHome(), "mcp.json"), { force: true });
  rmSync(join(dataHome(), "credentials.json"), { force: true });
});

const MCP_JSON = () => join(dataHome(), "mcp.json");

/** mcp.json's reference to a secret named `name`. */
const ref = (name: string): string => `\${${name}}`;

function readMcp(): { mcpServers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(MCP_JSON(), "utf8"));
}

/** A mind whose every task calls `calls` once, then says it is done. */
function scripted(calls: Record<string, unknown>): typeof createMind {
  let asked = 0;
  return () => ({
    async *stream(): AsyncGenerator<MindChunk> {
      if (asked++ === 0) {
        yield {
          type: "tool-calls",
          calls: [{ id: "m1", name: "mcp__fake__echo", arguments: calls }],
        };
        yield { type: "done", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text", text: "Done." };
      yield { type: "done", finishReason: "stop" };
    },
  });
}

function manager(mind?: typeof createMind): TaskManager {
  const made = new TaskManager({
    dataHome: dataHome(),
    builtinSkills: join(dataHome(), "builtin-skills"),
    settings: () => settings,
    addFolder: () => {},
    problem: () => null,
    report: async () => {},
    ...(mind === undefined ? {} : { createMind: mind }),
  });
  managers.push(made);
  return made;
}

interface Init {
  readonly body?: unknown;
  readonly auth?: boolean;
}

/** The MCP and task routes, as the local router serves them to the session. */
function serve(
  tasks: TaskManager,
): (method: string, path: string, init?: Init) => Promise<Response> {
  const router: RouteHandler = createLocalRouter(
    [...tasksRoutes(tasks), ...mcpRoutes(tasks)],
    (request) => (request.headers.get("authorization") === AUTH ? "bearer" : null),
  );
  const listening = serveRoutes({ "/api/local/*": router });
  servers.push(listening);
  return async (method, path, init = {}) => {
    const headers: Record<string, string> = init.auth === false ? {} : { authorization: AUTH };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    }
    return realFetch(`${(await listening).url}${path}`, { method, headers, body });
  };
}

async function refusal(response: Response): Promise<[number, string, string]> {
  const body = (await response.json()) as ErrorBody;
  return [response.status, body.error.code, body.error.message];
}

const GITHUB = {
  command: "docker",
  args: ["run", "-i", "--rm", "--init", "-e", "GITHUB_TOKEN", ref("IMAGE")],
  env: { GITHUB_TOKEN: ref("GITHUB_TOKEN"), LITERAL: "sk-literal-in-place" },
  description: "Issues and pull requests",
  tools: ["get_*"],
  alwaysAllow: ["get_issue", "search_issues"],
  disabled: true,
};

describe("GET mcp", () => {
  test("lists each server as mcp.json writes it, never an env value or what a reference resolves to", async () => {
    setEnv("IMAGE", undefined);
    setEnv("GITHUB_TOKEN", undefined);
    writeFileSync(
      MCP_JSON(),
      JSON.stringify({
        mcpServers: {
          github: GITHUB,
          broken: { command: "x", cwd: "relative" },
          local: { command: "npx", args: ["-y", "some-server"] },
          listed: "npx some-server",
        },
      }),
    );
    writeFileSync(
      join(dataHome(), "credentials.json"),
      JSON.stringify({ mcpSecrets: { GITHUB_TOKEN: "ghp-saved-secret" } }),
    );
    const call = serve(manager());

    const response = await call("GET", "/api/local/mcp");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("ghp-saved-secret");
    expect(text).not.toContain("sk-literal-in-place");
    expect(JSON.parse(text) as McpServersResponse).toEqual({
      path: MCP_JSON(),
      servers: [
        {
          name: "github",
          command: "docker",
          args: GITHUB.args,
          enabled: false,
          description: "Issues and pull requests",
          alwaysAllow: ["get_issue", "search_issues"],
          needs: [
            { name: "IMAGE", set: false },
            { name: "GITHUB_TOKEN", set: true },
          ],
          problem: null,
        },
        {
          name: "local",
          command: "npx",
          args: ["-y", "some-server"],
          enabled: true,
          alwaysAllow: [],
          needs: [],
          problem: null,
        },
        {
          name: "broken",
          enabled: true,
          alwaysAllow: [],
          needs: [],
          problem: 'server "broken": cwd must be an absolute path or start with ~/',
        },
        {
          name: "listed",
          enabled: true,
          alwaysAllow: [],
          needs: [],
          problem: 'server "listed" must be an object',
          unchangeable: true,
        },
      ],
      errors: [],
    });
  });

  test("a reference the environment sets counts as set; a blank one doesn't", async () => {
    writeFileSync(MCP_JSON(), JSON.stringify({ mcpServers: { github: GITHUB } }));
    setEnv("IMAGE", "ghcr.io/github/github-mcp-server");
    setEnv("GITHUB_TOKEN", "");
    const call = serve(manager());
    const { servers } = (await (await call("GET", "/api/local/mcp")).json()) as McpServersResponse;
    expect(servers[0]?.needs).toEqual([
      { name: "IMAGE", set: true },
      { name: "GITHUB_TOKEN", set: false },
    ]);
  });

  test("with no mcp.json, none; one that doesn't parse says so as a whole", async () => {
    const call = serve(manager());
    expect(await (await call("GET", "/api/local/mcp")).json()).toEqual({
      path: MCP_JSON(),
      servers: [],
      errors: [],
    });
    writeFileSync(MCP_JSON(), "{ not json");
    expect(await (await call("GET", "/api/local/mcp")).json()).toEqual({
      path: MCP_JSON(),
      servers: [],
      errors: [`${MCP_JSON()} isn't valid JSON`],
    });
  });
});

describe("PUT mcp/servers/:name", () => {
  test("turns off an entry that doesn't check out, its other fields left for the owner to fix", async () => {
    writeFileSync(
      MCP_JSON(),
      JSON.stringify({ mcpServers: { odd: { command: "x", tools: "read" } } }),
    );
    const call = serve(manager());
    const off = await call("PUT", "/api/local/mcp/servers/odd", { body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(((await off.json()) as McpServersResponse).servers).toEqual([
      {
        name: "odd",
        enabled: false,
        alwaysAllow: [],
        needs: [],
        problem: 'server "odd": tools must be an array of strings',
      },
    ]);
    expect(readMcp().mcpServers.odd).toEqual({ command: "x", tools: "read", enabled: false });
  });

  test("turns a server on, deleting Cline's disabled, and off; takes back one Always; the file keeps the rest, 0600", async () => {
    writeFileSync(
      MCP_JSON(),
      `${JSON.stringify({ mcpServers: { github: GITHUB }, other: 1 }, null, 4)}\n`,
    );
    const call = serve(manager());

    const on = await call("PUT", "/api/local/mcp/servers/github", { body: { enabled: true } });
    expect(on.status).toBe(200);
    expect(((await on.json()) as McpServersResponse).servers[0]?.enabled).toBe(true);
    const saved = readMcp();
    expect(saved.mcpServers.github).not.toHaveProperty("disabled");
    expect(saved.mcpServers.github).not.toHaveProperty("enabled");
    expect(saved).toMatchObject({ other: 1, mcpServers: { github: { env: GITHUB.env } } });
    expect(readFileSync(MCP_JSON(), "utf8")).toContain('\n    "mcpServers"');
    expect(statSync(MCP_JSON()).mode & 0o777).toBe(0o600);

    const off = await call("PUT", "/api/local/mcp/servers/github", {
      body: { enabled: false, revoke: "get_issue" },
    });
    expect(((await off.json()) as McpServersResponse).servers[0]).toMatchObject({
      enabled: false,
      alwaysAllow: ["search_issues"],
    });
    expect(readMcp().mcpServers.github).toMatchObject({
      enabled: false,
      alwaysAllow: ["search_issues"],
    });
  });

  test("a change that changes nothing leaves the owner's file as it was written", async () => {
    const text = `{"mcpServers": {"local": {"command": "npx", "args": ["-y", "s"]}}}`;
    writeFileSync(MCP_JSON(), text);
    const call = serve(manager());
    for (const body of [{ enabled: true }, { revoke: "never_allowed" }]) {
      expect((await call("PUT", "/api/local/mcp/servers/local", { body })).status).toBe(200);
    }
    expect(readFileSync(MCP_JSON(), "utf8")).toBe(text);
  });

  test("refuses to add an Always, or anything but enabled and revoke", async () => {
    writeFileSync(MCP_JSON(), JSON.stringify({ mcpServers: { github: GITHUB } }));
    const before = readFileSync(MCP_JSON(), "utf8");
    const call = serve(manager());
    for (const body of [
      { alwaysAllow: ["create_issue"] },
      { allow: "create_issue" },
      { enabled: true, allow: "create_issue" },
      {},
      { enabled: "yes" },
      { revoke: "" },
      { revoke: ["get_issue"] },
      ["enabled"],
    ]) {
      const [status, code] = await refusal(
        await call("PUT", "/api/local/mcp/servers/github", { body }),
      );
      expect([JSON.stringify(body), status, code]).toEqual([
        JSON.stringify(body),
        400,
        "bad-request",
      ]);
    }
    expect(readFileSync(MCP_JSON(), "utf8")).toBe(before);
  });

  test("a server mcp.json doesn't have is 404, naming nothing sent; a file that doesn't parse is 409 and left alone", async () => {
    writeFileSync(MCP_JSON(), JSON.stringify({ mcpServers: { github: GITHUB } }));
    const call = serve(manager());
    const [status, code, message] = await refusal(
      await call("PUT", "/api/local/mcp/servers/sk-pasted-key", { body: { enabled: true } }),
    );
    expect([status, code]).toEqual([404, "unknown-mcp-server"]);
    expect(message).not.toContain("sk-pasted-key");

    writeFileSync(MCP_JSON(), "{ not json");
    expect(
      (
        await refusal(
          await call("PUT", "/api/local/mcp/servers/github", { body: { enabled: false } }),
        )
      ).slice(0, 2),
    ).toEqual([409, "invalid-mcp-config"]);
    expect(readFileSync(MCP_JSON(), "utf8")).toBe("{ not json");
    rmSync(MCP_JSON());
    expect(
      (
        await refusal(
          await call("PUT", "/api/local/mcp/servers/github", { body: { enabled: false } }),
        )
      ).slice(0, 2),
    ).toEqual([404, "unknown-mcp-server"]);
  });

  test("an mcp.json linked to another client's config is 409, and neither file changes", async () => {
    // Another client's config, linked so that both read one file.
    const shared = join(work, "cline_mcp_settings.json");
    const text = `${JSON.stringify({ mcpServers: { github: GITHUB } }, null, 2)}\n`;
    writeFileSync(shared, text);
    symlinkSync(shared, MCP_JSON());
    const call = serve(manager());
    for (const body of [{ enabled: false }, { revoke: "get_issue" }]) {
      const [status, code] = await refusal(
        await call("PUT", "/api/local/mcp/servers/github", { body }),
      );
      expect([status, code]).toEqual([409, "linked-mcp-config"]);
    }
    expect(lstatSync(MCP_JSON()).isSymbolicLink()).toBe(true);
    expect(readFileSync(shared, "utf8")).toBe(text);
  });

  test("so is one hard-linked to it: a write would fork the two", async () => {
    const shared = join(work, "cline_mcp_settings.json");
    const text = `${JSON.stringify({ mcpServers: { github: GITHUB } }, null, 2)}\n`;
    writeFileSync(shared, text);
    linkSync(shared, MCP_JSON());
    const call = serve(manager());
    const [status, code] = await refusal(
      await call("PUT", "/api/local/mcp/servers/github", { body: { enabled: false } }),
    );
    expect([status, code]).toEqual([409, "linked-mcp-config"]);
    expect(statSync(MCP_JSON()).nlink).toBe(2);
    expect(readFileSync(shared, "utf8")).toBe(text);
  });

  test("without the session, 401", async () => {
    writeFileSync(MCP_JSON(), JSON.stringify({ mcpServers: { github: GITHUB } }));
    const call = serve(manager());
    expect((await call("GET", "/api/local/mcp", { auth: false })).status).toBe(401);
    const put = await call("PUT", "/api/local/mcp/servers/github", {
      body: { enabled: true },
      auth: false,
    });
    expect(put.status).toBe(401);
    expect(readMcp().mcpServers.github).toHaveProperty("disabled", true);
  });
});

describe("an MCP card's answer", () => {
  test("goes through as the page sends it, the whole question with it, even for a call with many long arguments", async () => {
    writeFileSync(
      MCP_JSON(),
      JSON.stringify({
        mcpServers: {
          fake: {
            command: process.execPath,
            args: [FIXTURE],
            env: jsRuntime().env,
            tools: ["echo"],
          },
        },
      }),
    );
    const args: Record<string, unknown> = { text: "hi" };
    for (let n = 0; n < 60; n++) args[`part${n}`] = `${"\u0001".repeat(100)}${"奶".repeat(300)}`;
    const tasks = manager(scripted(args));
    await tasks.boot();
    const call = serve(tasks);
    const { id } = await tasks.start(
      { goal: "Many", folder: join(work, "many") },
      { id: newId(), persona: "milky-green", call: "call-1" },
    );
    let paused: TaskSnapshot = await tasks.get(id);
    for (const deadline = Date.now() + 5000; paused.status !== "paused"; ) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await delay(5);
      paused = await tasks.get(id);
    }

    const answered = await call("POST", `/api/local/tasks/${id}/approve`, {
      body: { answer: "always", pending: paused.pending },
    });
    expect(answered.status).toBe(200);
    expect(readMcp().mcpServers.fake?.alwaysAllow).toEqual(["echo"]);
  });
});
