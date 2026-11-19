import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type McpServer,
  mcpReferences,
  mcpStanding,
  parseMcpConfig,
  patchMcpServer,
  readMcpConfig,
  readMcpSecrets,
  resolveMcpServer,
  toolNameMatcher,
} from "../src/mcp/servers.ts";
import { removeTempFolders, tempFolder } from "./tool-folder.ts";

const PATH = "/home/owner/.laplace/eidolon/mcp.json";
const TOKEN = "EIDOLON_MCP_TEST_TOKEN";
const OTHER = "EIDOLON_MCP_TEST_OTHER";

/** `${NAME}`, as mcp.json refers to a secret. */
const ref = (name: string) => `\${${name}}`;

afterEach(async () => {
  for (const name of [TOKEN, OTHER]) delete process.env[name];
  await removeTempFolders();
});

function configOf(servers: Record<string, unknown>) {
  return parseMcpConfig(JSON.stringify({ mcpServers: servers }), PATH);
}

function server(name: string, entry: Record<string, unknown>): McpServer {
  const config = configOf({ [name]: entry });
  expect(config.problems).toEqual([]);
  return config.servers[0] as McpServer;
}

describe("mcp.json", () => {
  test("reads mcpServers, skipping an invalid entry with its reason", () => {
    const config = configOf({
      files: { command: "npx", args: ["-y", "server-filesystem", "~/notes"], timeout: 5 },
      broken: { command: "x", args: "not a list" },
      docs: { url: "https://example.com/mcp" },
      "bad name": { command: "x" },
      git: {
        command: "docker",
        args: ["run", "-i", "--rm", "mcp/git"],
        description: " Git history\n",
      },
    });
    expect(config.readable).toBe(true);
    expect(config.servers).toEqual([
      {
        name: "files",
        command: "npx",
        args: ["-y", "server-filesystem", "~/notes"],
        env: {},
        timeoutMs: 5000,
        enabled: true,
        alwaysAllow: [],
      },
      {
        name: "git",
        command: "docker",
        args: ["run", "-i", "--rm", "mcp/git"],
        env: {},
        description: "Git history",
        timeoutMs: 60_000,
        enabled: true,
        alwaysAllow: [],
      },
    ]);
    expect(config.problems).toEqual([
      { server: "broken", error: 'server "broken": args must be an array of strings' },
      {
        server: "docs",
        error: 'server "docs": HTTP servers come later: run it through mcp-remote',
      },
      {
        server: "bad name",
        error: 'invalid server name "bad name" (use letters, digits, "_" and "-")',
      },
    ]);
  });

  test("keeps tools and alwaysAllow, and honors Cline's disabled", () => {
    const config = configOf({
      github: {
        command: "docker",
        tools: ["get_*", "create_issue"],
        alwaysAllow: ["get_issue"],
      },
      old: { command: "npx", disabled: true },
      off: { command: "npx", enabled: false },
      odd: { command: "npx", tools: "get_*" },
    });
    expect(
      config.servers.map(({ name, enabled, tools, alwaysAllow }) => ({
        name,
        enabled,
        tools,
        alwaysAllow,
      })),
    ).toEqual([
      {
        name: "github",
        enabled: true,
        tools: ["get_*", "create_issue"],
        alwaysAllow: ["get_issue"],
      },
      { name: "old", enabled: false, tools: undefined, alwaysAllow: [] },
      { name: "off", enabled: false, tools: undefined, alwaysAllow: [] },
    ]);
    expect(config.problems).toEqual([
      { server: "odd", error: 'server "odd": tools must be an array of strings' },
    ]);
  });

  test("marks an entry that isn't an object unchangeable: only an edit of the file reaches it", () => {
    const config = configOf({ listed: "npx some-server", odd: { command: "x", tools: "read" } });
    expect(config.problems).toEqual([
      { server: "listed", error: 'server "listed" must be an object', unchangeable: true },
      { server: "odd", error: 'server "odd": tools must be an array of strings' },
    ]);
  });

  test("refuses two names that differ only in - and _", () => {
    const config = configOf({ "my-server": { command: "a" }, my_server: { command: "b" } });
    expect(config.servers.map((each) => each.name)).toEqual(["my-server"]);
    expect(config.problems).toEqual([
      { server: "my_server", error: 'server "my_server" conflicts with "my-server"' },
    ]);
  });

  test("refuses a relative cwd, which would be the task's folder, and takes an absolute or ~/ one", () => {
    const config = configOf({
      here: { command: "npx", cwd: "." },
      sub: { command: "npx", cwd: "tools/bin" },
      abs: { command: "npx", cwd: "/srv/mcp" },
      home: { command: "npx", cwd: "~/mcp" },
    });
    expect(config.servers.map(({ name, cwd }) => [name, cwd])).toEqual([
      ["abs", "/srv/mcp"],
      ["home", "~/mcp"],
    ]);
    expect(config.problems.map((problem) => problem.error)).toEqual([
      'server "here": cwd must be an absolute path or start with ~/',
      'server "sub": cwd must be an absolute path or start with ~/',
    ]);
  });

  test("a file that doesn't parse, or isn't the mcpServers shape, starts no servers and decides nothing", async () => {
    const home = await tempFolder();
    await writeFile(join(home, "mcp.json"), '{ "mcpServers": { "a": { "command": "x", } } }');
    const config = await readMcpConfig(home);
    expect(config).toEqual({
      path: join(home, "mcp.json"),
      readable: false,
      servers: [],
      problems: [{ error: `${join(home, "mcp.json")} isn't valid JSON` }],
    });
    expect(mcpStanding(config, "a", "anything")).toBe("ask");
    expect(parseMcpConfig('{ "mcpServers": [] }', PATH)).toMatchObject({
      readable: false,
      problems: [{ error: `${PATH}: expected an object with an "mcpServers" object` }],
    });
  });

  test("no file is no servers, and a BOM is read past", async () => {
    const home = await tempFolder();
    expect(await readMcpConfig(home)).toEqual({
      path: join(home, "mcp.json"),
      readable: true,
      servers: [],
      problems: [],
    });
    const config = parseMcpConfig(
      `\uFEFF${JSON.stringify({ mcpServers: { a: { command: "x" } } })}`,
      PATH,
    );
    expect(config.servers.map((each) => each.name)).toEqual(["a"]);
  });

  test("tool patterns match exact names and * wildcards, and nothing else", () => {
    const matches = toolNameMatcher(["get_*", "create_issue", "*_pr"]);
    expect(["get_issue", "get_", "create_issue", "merge_pr"].map(matches)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["create_issues", "delete_issue", "xget_issue", "get.issue"].filter(matches)).toEqual(
      [],
    );
    expect(toolNameMatcher(["a.b"])("aXb")).toBe(false);
  });
});

describe("a call's standing in mcp.json", () => {
  test("off for a server turned off or taken out, always for an Always tool, else ask", () => {
    const config = configOf({
      github: { command: "docker", alwaysAllow: ["get_issue"] },
      old: { command: "npx", disabled: true },
      off: { command: "npx", enabled: false },
      broken: { command: "npx", tools: 1 },
      "broken-off": { url: "https://example.com/mcp", disabled: true },
    });
    expect(mcpStanding(config, "github", "get_issue")).toBe("always");
    expect(mcpStanding(config, "github", "create_issue")).toBe("ask");
    expect(mcpStanding(config, "old", "anything")).toBe("off");
    expect(mcpStanding(config, "off", "anything")).toBe("off");
    expect(mcpStanding(config, "gone", "anything")).toBe("off");
    // An entry that doesn't check out may still be the owner's: it asks, unless it is turned off.
    expect(mcpStanding(config, "broken", "anything")).toBe("ask");
    expect(mcpStanding(config, "broken-off", "anything")).toBe("off");
  });
});

describe("secrets", () => {
  test("resolves a reference from the environment, then credentials.json's mcpSecrets", async () => {
    const home = await tempFolder();
    await writeFile(
      join(home, "credentials.json"),
      JSON.stringify({
        OPENROUTER_API_KEY: "sk-app",
        mcpSecrets: { [TOKEN]: "from-file", [OTHER]: "other", EMPTY: "", N: 1 },
      }),
    );
    const secrets = await readMcpSecrets(home);
    expect(secrets).toEqual({ [TOKEN]: "from-file", [OTHER]: "other" });
    const unknown = `\${not a ref}`;
    const entry = server("gh", {
      command: "~/bin/gh-mcp",
      args: [`--token=${ref(TOKEN)}`, "~/repos", "$HOME", unknown],
      env: { TOKEN: ref(TOKEN), BOTH: `${ref(OTHER)}:${ref(TOKEN)}` },
      cwd: "~/work",
    });
    expect(mcpReferences(entry)).toEqual([TOKEN, OTHER]);
    expect(resolveMcpServer(entry, secrets)).toEqual({
      command: join(homedir(), "bin/gh-mcp"),
      args: ["--token=from-file", join(homedir(), "repos"), "$HOME", unknown],
      env: { TOKEN: "from-file", BOTH: "other:from-file" },
      cwd: join(homedir(), "work"),
      secrets: new Map([
        [TOKEN, "from-file"],
        [OTHER, "other"],
      ]),
    });
    process.env[TOKEN] = "from-env";
    expect(resolveMcpServer(entry, secrets)).toMatchObject({
      env: { TOKEN: "from-env", BOTH: "other:from-env" },
    });
  });

  test("a blank environment variable falls through to mcpSecrets", () => {
    process.env[TOKEN] = "";
    const entry = server("gh", { command: "gh-mcp", env: { TOKEN: ref(TOKEN) } });
    expect(resolveMcpServer(entry, { [TOKEN]: "from-file" })).toMatchObject({
      env: { TOKEN: "from-file" },
    });
  });

  test("a reference with no value names the variable it needs", () => {
    const entry = server("gh", { command: "gh-mcp", env: { TOKEN: ref(TOKEN) } });
    expect(resolveMcpServer(entry, { [TOKEN]: "" })).toEqual({ missing: TOKEN });
  });

  test("a credentials.json that doesn't parse, or has no mcpSecrets, gives none", async () => {
    const home = await tempFolder();
    expect(await readMcpSecrets(home)).toEqual({});
    await writeFile(join(home, "credentials.json"), "{ not json");
    expect(await readMcpSecrets(home)).toEqual({});
    await writeFile(join(home, "credentials.json"), JSON.stringify({ mcpSecrets: ["a"] }));
    expect(await readMcpSecrets(home)).toEqual({});
  });
});

describe("patchMcpServer", () => {
  const TEXT = `{
    "theme": "dark",
    "mcpServers": {
        "github": {
            "command": "docker",
            "alwaysAllow": ["get_issue"],
            "enabled": false
        },
        "old": { "command": "npx", "disabled": true }
    }
}
`;

  test("keeps the file's other keys and indentation", () => {
    const patched = patchMcpServer(TEXT, "github", { enabled: true });
    expect(patched).toEqual({
      kind: "patched",
      text: `${JSON.stringify(
        {
          theme: "dark",
          mcpServers: {
            github: { command: "docker", alwaysAllow: ["get_issue"] },
            old: { command: "npx", disabled: true },
          },
        },
        null,
        "    ",
      )}\n`,
    });
  });

  test("turning a Cline-disabled server on deletes disabled, and turning one off writes enabled: false", () => {
    const on = patchMcpServer(TEXT, "old", { enabled: true });
    if (on.kind !== "patched") throw new Error(on.kind);
    expect(JSON.parse(on.text).mcpServers.old).toEqual({ command: "npx" });
    expect(configOf(JSON.parse(on.text).mcpServers).servers[1]?.enabled).toBe(true);
    const off = patchMcpServer(on.text, "old", { enabled: false });
    if (off.kind !== "patched") throw new Error(off.kind);
    expect(JSON.parse(off.text).mcpServers.old).toEqual({ command: "npx", enabled: false });
  });

  test("adds an Always once and takes one back, dropping an empty list", () => {
    const added = patchMcpServer(TEXT, "github", { allow: "search_issues" });
    if (added.kind !== "patched") throw new Error(added.kind);
    expect(JSON.parse(added.text).mcpServers.github.alwaysAllow).toEqual([
      "get_issue",
      "search_issues",
    ]);
    const again = patchMcpServer(added.text, "github", { allow: "search_issues" });
    if (again.kind !== "patched") throw new Error(again.kind);
    expect(JSON.parse(again.text).mcpServers.github.alwaysAllow).toEqual([
      "get_issue",
      "search_issues",
    ]);
    const revoked = patchMcpServer(TEXT, "github", { revoke: "get_issue" });
    if (revoked.kind !== "patched") throw new Error(revoked.kind);
    expect(JSON.parse(revoked.text).mcpServers.github).toEqual({
      command: "docker",
      enabled: false,
    });
  });

  test("never writes over a file that doesn't parse, and knows only its own servers", () => {
    expect(patchMcpServer("{ nope", "github", { enabled: true })).toEqual({
      kind: "invalid-config",
    });
    expect(patchMcpServer('{ "mcpServers": 1 }', "github", { enabled: true })).toEqual({
      kind: "invalid-config",
    });
    expect(patchMcpServer(TEXT, "gitlab", { enabled: true })).toEqual({ kind: "unknown-server" });
    expect(patchMcpServer(TEXT, "constructor", { enabled: true })).toEqual({
      kind: "unknown-server",
    });
    expect(patchMcpServer(undefined, "github", { enabled: true })).toEqual({
      kind: "unknown-server",
    });
  });
});
