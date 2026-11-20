// /api/local/skills: the owner's skills and the built-in ones, for Settings. The owner switches
// them, and writes new ones into the data home's skills folder; a task's own folder's skills are
// never listed.
import { MAX_SKILL_BYTES } from "@eidolon/assistant";
import { isPlainObject } from "@eidolon/config";
import type { SkillCreate } from "../api.ts";
import { localError, localJson, readJson } from "../responses.ts";
import type { LocalRouteSpec } from "../router.ts";
import type { TaskManager } from "../tasks/manager.ts";
import { answer } from "./tasks.ts";

const SWITCH_BODY_LIMIT = 1024;
/** A SKILL.md of 256 KB, the most a task reads, as JSON. */
const CREATE_BODY_LIMIT = 2 * MAX_SKILL_BYTES;
const CREATE_FIELDS: ReadonlySet<string> = new Set(["name", "description", "instructions"]);

/** The POST's body as a skill to write; null for anything but its three texts. */
function createOf(body: unknown): SkillCreate | null {
  if (!isPlainObject(body)) return null;
  const fields = Object.keys(body);
  if (fields.length !== CREATE_FIELDS.size || fields.some((field) => !CREATE_FIELDS.has(field))) {
    return null;
  }
  const { name, description, instructions } = body;
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    typeof instructions !== "string"
  ) {
    return null;
  }
  return { name, description, instructions };
}

export function skillsRoutes(tasks: TaskManager): LocalRouteSpec[] {
  return [
    {
      route: "GET /api/local/skills",
      handler: async () => localJson(200, await tasks.skills()),
    },
    {
      route: "POST /api/local/skills",
      async handler(request) {
        const body = await readJson(request, CREATE_BODY_LIMIT);
        if (!body.ok) return body.response;
        const skill = createOf(body.value);
        if (skill === null) {
          return localError(
            400,
            "bad-request",
            "Send {name, description, instructions}, each text",
          );
        }
        return answer(() => tasks.createSkill(skill));
      },
    },
    {
      route: "PUT /api/local/skills/:name",
      async handler(request, { params }) {
        const body = await readJson(request, SWITCH_BODY_LIMIT);
        if (!body.ok) return body.response;
        const { value } = body;
        if (
          !isPlainObject(value) ||
          Object.keys(value).length !== 1 ||
          typeof value.enabled !== "boolean"
        ) {
          return localError(400, "bad-request", "Send {enabled: true or false}");
        }
        const { enabled } = value;
        return answer(() => tasks.changeSkill(params.name as string, enabled));
      },
    },
  ];
}
