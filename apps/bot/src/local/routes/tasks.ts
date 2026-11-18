// /api/local/tasks: the app's tasks, which she starts in a chat with start_task, and the answers
// the owner gives from each one's card. No route starts, steers or deletes a task. Beside them,
// /api/local/assistant/commands: the commands those answers allowed for good.
import { resolve } from "node:path";
import { isChatId } from "@eidolon/chat";
import { dataHome, expandUser, isPlainObject, pyStrip } from "@eidolon/config";
import type { TaskApproveRequest, TaskContinueRequest } from "../api.ts";
import { editSettingsYaml, setDotted, type Tree, writeFailure } from "../personas.ts";
import { localError, localJson, ndjsonResponse, readJson } from "../responses.ts";
import { reinstallSettings } from "../restart.ts";
import type { LocalApp, LocalRouteSpec } from "../router.ts";
import { TASK_ID, type TaskManager, TaskRefused } from "../tasks/manager.ts";

const TASK_BODY_LIMIT = 16 * 1024;

/** TaskRefused's answer; anything else is rethrown. */
function refusal(error: unknown): Response {
  if (error instanceof TaskRefused) return localError(error.status, error.code, error.message);
  throw error;
}

async function answer(work: () => Promise<unknown>): Promise<Response> {
  try {
    return localJson(200, await work());
  } catch (error) {
    return refusal(error);
  }
}

/** The 400 for a path's `:id` that is no task id; ids are only ever looked up. */
function idRefusal(id: string): Response | null {
  return TASK_ID.test(id) ? null : localError(400, "bad-request", "That is not a task id");
}

/** settings.yaml's assistant.folders: a list, or one string of comma-separated folders. */
function savedFolders(tree: Tree): string[] {
  const assistant = tree.assistant;
  const value = isPlainObject(assistant) ? assistant.folders : undefined;
  const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return items.filter((item): item is string => typeof item === "string" && pyStrip(item) !== "");
}

/**
 * An Always answer on a task's card: `folder` joins assistant.folders in settings.yaml, unless the
 * file lists it already, and the settings are installed again for the next run's grants.
 */
export function addAssistantFolder(app: LocalApp, folder: string): void {
  // The setting is read back split on commas, each part through JS's trim and Python's strip: a
  // folder either changes comes back as another, and a worker's /tmp/a,/etc as /etc.
  if (folder.includes(",") || folder.trim() !== folder || pyStrip(folder) !== folder) {
    throw new TaskRefused(
      400,
      "bad-request",
      `assistant.folders can't hold ${folder}: its path has a comma, or whitespace at an end. Allow it once instead`,
    );
  }
  const home = dataHome();
  editSettingsYaml((tree) => {
    const saved = savedFolders(tree);
    // As the settings resolve an entry: ~ expanded, and a relative one under the data home.
    if (saved.some((entry) => resolve(home, expandUser(pyStrip(entry))) === folder)) return;
    setDotted(tree, "assistant.folders", [...saved, folder]);
  });
  reinstallSettings(app);
}

export function tasksRoutes(tasks: TaskManager): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/tasks",
      handler(_request, { url }) {
        const chat = url.searchParams.get("chat");
        if (chat !== null && !isChatId(chat)) {
          return localError(400, "bad-request", "`chat` is a chat's id");
        }
        return answer(async () => ({ tasks: await tasks.list(chat === null ? {} : { chat }) }));
      },
    },
    {
      route: "GET /api/local/tasks/:id",
      handler(_request, { params }) {
        const id = params.id as string;
        return idRefusal(id) ?? answer(() => tasks.get(id));
      },
    },
    {
      route: "GET /api/local/tasks/:id/events",
      async handler(_request, { params, url }) {
        const id = params.id as string;
        const refused = idRefusal(id);
        if (refused !== null) return refused;
        const after = url.searchParams.get("after") ?? "0";
        if (!/^\d{1,15}$/.test(after)) {
          return localError(400, "bad-request", "`after` is a byte offset into the transcript");
        }
        try {
          return ndjsonResponse(await tasks.events(id, Number(after)));
        } catch (error) {
          return refusal(error);
        }
      },
    },
    {
      route: "POST /api/local/tasks/:id/approve",
      async handler(request, { params }) {
        const id = params.id as string;
        const refused = idRefusal(id);
        if (refused !== null) return refused;
        const body = await readJson(request, TASK_BODY_LIMIT);
        if (!body.ok) return body.response;
        try {
          return localJson(200, await tasks.approve(id, body.value as TaskApproveRequest));
        } catch (error) {
          // An Always answer writes settings.yaml, which can refuse as a settings PUT's write does.
          return error instanceof TaskRefused ? refusal(error) : writeFailure(error);
        }
      },
    },
    {
      route: "POST /api/local/tasks/:id/continue",
      async handler(request, { params }) {
        const id = params.id as string;
        const refused = idRefusal(id);
        if (refused !== null) return refused;
        const body = await readJson(request, TASK_BODY_LIMIT);
        if (!body.ok) return body.response;
        return answer(() => tasks.continue(id, body.value as TaskContinueRequest));
      },
    },
    {
      route: "DELETE /api/local/tasks/:id",
      handler(_request, { params }) {
        const id = params.id as string;
        return idRefusal(id) ?? answer(() => tasks.cancel(id));
      },
    },
    {
      route: "GET /api/local/assistant/commands",
      handler: () => answer(async () => ({ commands: await tasks.allowedCommands() })),
    },
    {
      route: "DELETE /api/local/assistant/commands/:id",
      handler(_request, { params }) {
        const id = params.id as string;
        // Its id is a UUIDv7, as a task's is.
        if (!TASK_ID.test(id)) {
          return localError(400, "bad-request", "That is not an allowed command's id");
        }
        return answer(async () => ({ commands: await tasks.disallowCommand(id) }));
      },
    },
  ];
}
