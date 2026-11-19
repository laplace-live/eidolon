// /api/local/skills over a manager, as the local router serves it: what Settings is shown of the
// owner's skill folders, the switch a PUT flips, a skill a POST writes, and what each refuses.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skillSwitchesPath } from "@eidolon/assistant";
import { dataHome, sharedSkillsDir } from "@eidolon/config";
import type { RouteHandler } from "../../src/app.ts";
import type { ErrorBody, SkillsResponse } from "../../src/local/api.ts";
import { createLocalRouter } from "../../src/local/router.ts";
import { skillsRoutes } from "../../src/local/routes/skills.ts";
import { TaskManager } from "../../src/local/tasks/manager.ts";
import { ensureDataHome } from "../../src/local/write.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";

const AUTH = "Bearer test-secret";

let logs: CapturedLogs;
const managers: TaskManager[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

beforeEach(() => {
  ensureDataHome();
  logs = captureLogs();
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const tasks of managers.splice(0)) await tasks.stop();
  logs.restore();
  rmSync(join(dataHome(), "skills"), { recursive: true, force: true });
  rmSync(skillSwitchesPath(dataHome()), { force: true });
  rmSync(sharedSkillsDir(), { recursive: true, force: true });
});

function skill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps.\n`,
  );
}

/** The skills routes over a fresh manager, as the local router serves them to the session. */
function serve(): (method: string, path: string, body?: unknown) => Promise<Response> {
  const tasks = new TaskManager({
    dataHome: dataHome(),
    settings: () => ({
      enabled: true,
      folders: [],
      bash: true,
      spendPauseUsd: 1,
      contextTokens: 128_000,
      permissions: "ask",
    }),
    addFolder: () => {},
    problem: () => null,
    report: async () => {},
  });
  managers.push(tasks);
  const router: RouteHandler = createLocalRouter(skillsRoutes(tasks), (request) =>
    request.headers.get("authorization") === AUTH ? "bearer" : null,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: { "/api/local/*": router },
    fetch: () => new Response(null, { status: 404 }),
  });
  servers.push(server);
  return (method, path, body) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: {
        authorization: AUTH,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
}

async function refusal(response: Response): Promise<[number, string]> {
  const body = (await response.json()) as ErrorBody;
  return [response.status, body.error.code];
}

describe("skills routes", () => {
  test("GET lists both folders' skills; PUT switches one by name, answering as GET does", async () => {
    skill(join(dataHome(), "skills", "house-style"), "house-style", "House style.");
    skill(join(sharedSkillsDir(), "ship"), "ship", "Ship a change.");
    const api = serve();
    const listed = (await (await api("GET", "/api/local/skills")).json()) as SkillsResponse;
    expect(listed.skills.map(({ name, source, enabled }) => [name, source, enabled])).toEqual([
      ["house-style", "eidolon", true],
      ["ship", "shared", true],
    ]);
    const put = await api("PUT", "/api/local/skills/ship", { enabled: false });
    expect(put.status).toBe(200);
    const after = (await put.json()) as SkillsResponse;
    expect(after.skills.map(({ name, enabled }) => [name, enabled])).toEqual([
      ["house-style", true],
      ["ship", false],
    ]);
    expect(JSON.parse(readFileSync(skillSwitchesPath(dataHome()), "utf8"))).toEqual({
      disabled: ["ship"],
    });
    expect(await refusal(await api("PUT", "/api/local/skills/nope", { enabled: false }))).toEqual([
      404,
      "unknown-skill",
    ]);
    for (const body of [{}, { enabled: "no" }, { enabled: true, extra: 1 }, [true]]) {
      expect(await refusal(await api("PUT", "/api/local/skills/ship", body))).toEqual([
        400,
        "bad-request",
      ]);
    }
  });

  test("POST writes a skill into the data home's skills folder, and refuses one that is there or won't do", async () => {
    const api = serve();
    const created = await api("POST", "/api/local/skills", {
      name: "notes",
      description: "How I keep notes.",
      instructions: "One line a day.",
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as SkillsResponse).skills.map((each) => each.name)).toEqual([
      "notes",
    ]);
    expect(readFileSync(join(dataHome(), "skills", "notes", "SKILL.md"), "utf8")).toBe(
      '---\nname: notes\ndescription: "How I keep notes."\n---\n\nOne line a day.\n',
    );
    const again = { name: "notes", description: "Again.", instructions: "Again." };
    expect(await refusal(await api("POST", "/api/local/skills", again))).toEqual([
      409,
      "skill-exists",
    ]);
    for (const body of [
      { name: "Notes", description: "D.", instructions: "I." },
      { name: "notes2", description: "D." },
      { name: "notes2", description: "D.", instructions: 7 },
      { name: "notes2", description: "D.", instructions: "I.", extra: true },
    ]) {
      expect(await refusal(await api("POST", "/api/local/skills", body))).toEqual([
        400,
        "bad-request",
      ]);
    }
  });
});
