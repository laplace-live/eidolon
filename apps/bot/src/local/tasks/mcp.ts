// The owner's MCP servers as the app shows and changes them: mcp.json in the data home, which the
// owner edits by hand. The app switches a server and adds or takes back a tool's Always, keeping
// the rest of the file, and never writes over one that doesn't parse, or one that is a link.
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type McpConfig,
  type McpSecrets,
  type McpServerPatch,
  mcpReferences,
  mcpSecretValue,
  patchMcpServer,
} from "@eidolon/assistant";
import type { McpServersResponse, McpServerView } from "../api.ts";
import { writeDataFile } from "../write.ts";

const MCP_FILE = "mcp.json";
/** Where a server with no cwd of its own runs: inside the data home, which no task may write. */
export const MCP_FOLDER = "mcp";

/** mcp.json for Settings: what each entry runs as written, never an env value or a secret's. */
export function mcpServersView(config: McpConfig, secrets: McpSecrets): McpServersResponse {
  const servers: McpServerView[] = config.servers.map((server) => ({
    name: server.name,
    command: server.command,
    args: server.args,
    enabled: server.enabled,
    ...(server.description === undefined ? {} : { description: server.description }),
    alwaysAllow: server.alwaysAllow,
    needs: mcpReferences(server).map((name) => ({
      name,
      set: mcpSecretValue(name, secrets) !== undefined,
    })),
    problem: null,
  }));
  const errors: string[] = [];
  for (const { server, error, off } of config.problems) {
    if (server === undefined) errors.push(error);
    else {
      servers.push({
        name: server,
        enabled: off !== true,
        alwaysAllow: [],
        needs: [],
        problem: error,
      });
    }
  }
  return { path: config.path, servers, errors };
}

/** What became of a change: anything but patched leaves the file as it was. */
export type McpFileChange = "patched" | "unknown-server" | "invalid-config" | "linked";

/** mcp.json's changes, one after another, so that two can't drop each other's. */
export class McpFile {
  readonly #path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataHome: string) {
    this.#path = join(dataHome, MCP_FILE);
  }

  /** Applies `patch` to server `name`'s entry, writing the file, 0600, only when that changes it. */
  change(name: string, patch: McpServerPatch): Promise<McpFileChange> {
    const result = this.#queue.then(() => this.#change(name, patch));
    this.#queue = result.catch(() => {});
    return result;
  }

  async #change(name: string, patch: McpServerPatch): Promise<McpFileChange> {
    // An mcp.json linked to another client's config, symbolically or hard, would be replaced by a
    // copy: that config then never gets the change, and its own changes no longer reach tasks.
    const linked = await lstat(this.#path).then(
      (found) => found.isSymbolicLink() || found.nlink > 1,
      () => false,
    );
    if (linked) return "linked";
    let text: string | undefined;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    }
    const patched = patchMcpServer(text, name, patch);
    if (patched.kind !== "patched") return patched.kind;
    // patchMcpServer lays the whole file out anew: a change that changes nothing keeps the owner's.
    const before = patchMcpServer(text, name, {});
    if (before.kind !== "patched" || before.text !== patched.text) {
      writeDataFile(this.#path, patched.text, { secret: true });
    }
    return "patched";
  }
}
