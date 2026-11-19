// The booted local server's tasks: the routes behind the guard and the session, the manager made
// and started with the server, PUT settings turning Assistant Mode off, and the server's stop. A
// task's model requests go to a local server that holds each one until its client gives up.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  newTaskId,
  openTaskStore,
  readSnapshot,
  type TaskSnapshot,
  tasksDir,
  writeSnapshot,
} from "@eidolon/assistant";
import { PROOF_HEADER, type Status, type TasksResponse } from "../../src/local/api.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot, fakeIo } from "./harness.ts";

const SITE = "http://localhost:3000";
const ORIGIN = { id: Bun.randomUUIDv7(), persona: "milky-green", call: "call-1" };

/** A model server that answers nothing: each request waits until its client gives up on it. */
interface HeldModel {
  readonly requests: Request[];
  /** OPENROUTER_API_BASE for it. */
  readonly base: string;
  stop(): void;
}

function heldModel(): HeldModel {
  const requests: Request[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request);
      return new Promise<Response>((resolve) => {
        request.signal.addEventListener("abort", () => resolve(new Response(null)), {
          once: true,
        });
      });
    },
  });
  return {
    requests,
    base: `http://127.0.0.1:${server.port}/api/v1`,
    stop: () => server.stop(true),
  };
}

let booted: Booted | null = null;
let model: HeldModel | null = null;
let work = "";
let logs: CapturedLogs;
const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

beforeAll(() => {
  // Only the servers these tests start answer: anything else is a request that could bill.
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== "127.0.0.1") throw new Error(`unexpected network call: ${url}`);
    return realFetch(input, init);
  }) as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  logs = captureLogs();
  work = mkdtempSync(join(tmpdir(), "eidolon-task-server-"));
});

afterEach(async () => {
  await booted?.stop();
  booted = null;
  model?.stop();
  model = null;
  logs.restore();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  rmSync(work, { recursive: true, force: true });
  cleanUpBoot();
});

/** Assistant Mode ready, on an OpenRouter account whose API is the held model server. */
function readyAssistant(): HeldModel {
  model = heldModel();
  setEnv("ASSISTANT_PROVIDER", "openrouter");
  setEnv("ASSISTANT_MODEL", "test/model");
  setEnv("OPENROUTER_API_KEY", "test-key");
  setEnv("OPENROUTER_API_BASE", model.base);
  return model;
}

/** A task left on disk by an earlier start of the app, or by laplace-task with `chat: undefined`. */
async function seed(changes: Partial<TaskSnapshot>): Promise<TaskSnapshot> {
  const id = newTaskId();
  const dir = join(tasksDir(), id);
  const brief = {
    goal: "Seeded",
    deliverable: "Seeded",
    folder: join(work, "seeded"),
    check: "It is there",
  };
  await openTaskStore(dir).append({ type: "brief", brief });
  const snapshot = {
    v: 1,
    id,
    createdAt: Date.now(),
    status: "interrupted",
    chat: ORIGIN,
    brief,
    model: { account: "openrouter", model: "test/model" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
    ...changes,
  } as TaskSnapshot;
  await writeSnapshot(dir, snapshot);
  return snapshot;
}

function onDisk(id: string): Promise<TaskSnapshot | null> {
  return readSnapshot(join(tasksDir(), id));
}

function types(id: string): string[] {
  return readFileSync(join(tasksDir(), id, "transcript.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

function server(): Booted {
  if (booted === null) throw new Error("not booted");
  return booted;
}

/** A request from the app's own page. */
function api(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${server().base}${path}`, {
    method,
    headers: { ...server().session, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function assistantStatus(): Promise<Status["assistant"]> {
  return ((await (await api("GET", "/api/local/status")).json()) as Status).assistant;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

describe("the task routes", () => {
  test("answer only the app's own pages: a listed origin gets 403, a request without the session 401", async () => {
    const task = await seed({ status: "interrupted" });
    // What a PUT below would turn off.
    const mcp = '{"mcpServers": {"fake": {"command": "x"}}}';
    writeFileSync(join(dirname(tasksDir()), "mcp.json"), mcp);
    setEnv("EIDOLON_LOCAL_ALLOWED_ORIGINS", SITE);
    booted = await bootFixture();
    const id = task.id;
    for (const [method, path, body] of [
      ["GET", "/api/local/tasks", undefined],
      ["GET", `/api/local/tasks/${id}`, undefined],
      ["GET", `/api/local/tasks/${id}/events`, undefined],
      ["POST", `/api/local/tasks/${id}/approve`, '{"answer":"deny"}'],
      ["POST", `/api/local/tasks/${id}/continue`, "{}"],
      ["DELETE", `/api/local/tasks/${id}`, undefined],
      ["GET", "/api/local/assistant/commands", undefined],
      ["DELETE", `/api/local/assistant/commands/${Bun.randomUUIDv7()}`, undefined],
      ["GET", "/api/local/mcp", undefined],
      ["PUT", "/api/local/mcp/servers/fake", '{"enabled":false}'],
    ] as const) {
      // A listed site's page gets Eidolon's cookie too, since cookies ignore ports.
      const listed = await fetch(`${booted.base}${path}`, {
        method,
        body,
        headers: {
          Origin: SITE,
          "Sec-Fetch-Site": "same-site",
          Cookie: booted.cookie,
          [PROOF_HEADER]: booted.proof,
        },
      });
      const cors = [...listed.headers.keys()].filter((name) => name.startsWith("access-control-"));
      expect([method, path, listed.status, cors]).toEqual([method, path, 403, []]);
      const anonymous = await fetch(`${booted.base}${path}`, { method, body });
      expect([method, path, anonymous.status]).toEqual([method, path, 401]);
    }
    expect(await onDisk(id)).toEqual(task);
    expect(readFileSync(join(dirname(tasksDir()), "mcp.json"), "utf8")).toBe(mcp);
  });
});

describe("the manager", () => {
  test("starts with the server: a task a crash left running is interrupted, and laplace-task's are left alone", async () => {
    const crashed = await seed({ status: "running" });
    const cli = await seed({ status: "running", chat: undefined });
    booted = await bootFixture();
    // Before any request asked for the tasks.
    expect((await onDisk(crashed.id))?.status).toBe("interrupted");

    const listed = (await (await api("GET", "/api/local/tasks")).json()) as TasksResponse;
    expect(listed.tasks.map(({ id, status }) => [id, status])).toEqual([
      [crashed.id, "interrupted"],
    ]);
    expect((await api("GET", `/api/local/tasks/${cli.id}`)).status).toBe(404);
    expect(await onDisk(cli.id)).toEqual(cli);
    // Not ready, so nothing resumed: the crashed task waits for Continue.
    expect(await assistantStatus()).toEqual({
      enabled: true,
      ready: false,
      problem: "No provider fills ASSISTANT_PROVIDER",
      running: 0,
      search: { on: false, problem: null },
      kinds: { quick: null, coding: null, research: null },
    });
  });

  test("starts once the server has its shutdown: a supervisor gone while the tasks load still stops it", async () => {
    const crashed = await seed({ status: "running" });
    const status = () =>
      (JSON.parse(readFileSync(join(tasksDir(), crashed.id, "task.json"), "utf8")) as TaskSnapshot)
        .status;
    const io = fakeIo();
    let atShutdown: string | null = null;
    io.onShutdown = (handler) => {
      io.shutdown = handler;
      atShutdown = status();
    };
    booted = await bootFixture({ io });
    // The load marks the task a crash left running interrupted: the handler came before it.
    expect([atShutdown, status()]).toEqual(["running", "interrupted"]);
  });

  test("resumes an interrupted task once the server is up; turning Assistant Mode off stops it before the answer", async () => {
    const held = readyAssistant();
    const task = await seed({ status: "interrupted" });
    booted = await bootFixture();
    await until(() => held.requests.length === 1);
    expect(new URL(held.requests[0]?.url ?? "").pathname).toBe("/api/v1/chat/completions");
    expect(
      (await (await api("GET", `/api/local/tasks/${task.id}`)).json()) as TaskSnapshot,
    ).toMatchObject({ status: "running" });
    expect(await assistantStatus()).toEqual({
      enabled: true,
      ready: true,
      problem: null,
      running: 1,
      search: { on: false, problem: null },
      kinds: { quick: null, coding: null, research: null },
    });

    const put = await api("PUT", "/api/local/settings", {
      scope: "app",
      values: { "assistant.enabled": false },
    });
    expect(put.status).toBe(200);
    expect(
      (await (await api("GET", `/api/local/tasks/${task.id}`)).json()) as TaskSnapshot,
    ).toMatchObject({ status: "cancelled", outcome: { status: "cancelled" } });
    expect(held.requests[0]?.signal.aborted).toBe(true);
    expect(types(task.id).at(-1)).toBe("end");
    expect(await assistantStatus()).toEqual({
      enabled: false,
      ready: true,
      problem: null,
      running: 0,
      search: { on: false, problem: null },
      kinds: { quick: null, coding: null, research: null },
    });
  });

  test("stops with the server, leaving a running task interrupted, and the next start resumes it", async () => {
    const held = readyAssistant();
    const task = await seed({ status: "interrupted" });
    booted = await bootFixture();
    await until(() => held.requests.length === 1);

    await booted.stop();
    booted = null;
    await until(() => held.requests[0]?.signal.aborted === true);
    expect((await onDisk(task.id))?.status).toBe("interrupted");
    // Nothing stored after the server stopped reading the run: no end.
    expect(types(task.id)).not.toContain("end");

    booted = await bootFixture();
    await until(() => held.requests.length === 2);
    expect((await onDisk(task.id))?.status).toBe("running");
  });
});

describe("Assistant folders", () => {
  test("PUT settings refuses one that is or holds the home folder, which no task may be granted", async () => {
    readyAssistant();
    booted = await bootFixture();
    const home = homedir();
    const put = (folders: readonly string[]) =>
      api("PUT", "/api/local/settings", { scope: "app", values: { "assistant.folders": folders } });
    for (const [folder, named] of [
      [home, home],
      [`${home}/`, home],
      [dirname(home), dirname(home)],
      ["~", home],
      ["~/.", home],
      ["~/..", dirname(home)],
      ["/", "/"],
    ] as const) {
      const refused = await put([join(work, "site"), folder]);
      expect([folder, refused.status, await refused.json()]).toEqual([
        folder,
        400,
        {
          error: {
            code: "invalid-setting",
            message: `No task may be granted ${named}: it is or holds the home folder`,
          },
        },
      ]);
    }
    expect(await assistantStatus()).toMatchObject({ ready: true, problem: null });
    expect((await put([join(work, "site"), "~/Documents"])).status).toBe(200);
  });
});
