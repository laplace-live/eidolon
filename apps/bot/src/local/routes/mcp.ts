// /api/local/mcp: the MCP servers mcp.json gives tasks, for Settings. The owner switches one or
// takes back a tool's Always there; only a task's card adds one.
import { isPlainObject } from "@eidolon/config";
import type { McpServerChange } from "../api.ts";
import { writeFailure } from "../personas.ts";
import { localError, localJson, readJson } from "../responses.ts";
import type { LocalRouteSpec } from "../router.ts";
import { type TaskManager, TaskRefused } from "../tasks/manager.ts";

const MCP_BODY_LIMIT = 16 * 1024;
const FIELDS: ReadonlySet<string> = new Set(["enabled", "revoke"]);

/** The PUT's body as a change; null for anything else, an Always to add included. */
function changeOf(body: unknown): McpServerChange | null {
  if (!isPlainObject(body)) return null;
  const fields = Object.keys(body);
  if (fields.length === 0 || fields.some((field) => !FIELDS.has(field))) return null;
  const { enabled, revoke } = body;
  if (enabled !== undefined && typeof enabled !== "boolean") return null;
  if (revoke !== undefined && (typeof revoke !== "string" || revoke === "")) return null;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(revoke === undefined ? {} : { revoke }),
  };
}

export function mcpRoutes(tasks: TaskManager): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/mcp",
      handler: async () => localJson(200, await tasks.mcpServers()),
    },
    {
      route: "PUT /api/local/mcp/servers/:name",
      async handler(request, { params }) {
        const body = await readJson(request, MCP_BODY_LIMIT);
        if (!body.ok) return body.response;
        const change = changeOf(body.value);
        if (change === null) {
          return localError(400, "bad-request", "Send {enabled?: true or false, revoke?: a tool}");
        }
        try {
          return localJson(200, await tasks.changeMcpServer(params.name as string, change));
        } catch (error) {
          if (error instanceof TaskRefused) {
            return localError(error.status, error.code, error.message);
          }
          return writeFailure(error);
        }
      },
    },
  ];
}
