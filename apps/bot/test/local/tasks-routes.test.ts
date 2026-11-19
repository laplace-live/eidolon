// /api/local/tasks over a manager on a scripted mind, with no network: each route's answers and
// refusals, the events stream, PUT settings turning Assistant Mode off, and status' count. The
// booted server's guard, boot and stop are in tasks-server.test.ts.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newTaskId,
  openTaskStore,
  readSnapshot,
  type TaskChat,
  type TaskSnapshot,
  type TaskStatus,
  tasksDir,
  writeSnapshot,
} from "@eidolon/assistant";
import {
  type AssistantSettings,
  assistantSettings,
  dataHome,
  installSettings,
  resetSettings,
} from "@eidolon/config";
import { acquireLock } from "@eidolon/config/lock";
import type { createMind, MindChunk, MindRequest, MindToolCall } from "@eidolon/engine";
import { ProviderConfigError, reportUsage } from "@eidolon/providers";
import type { RouteHandler } from "../../src/app.ts";
import type { AllowedCommandsResponse, ErrorBody, TasksResponse } from "../../src/local/api.ts";
import { createLocalRouter, type LocalApp } from "../../src/local/router.ts";
import { settingsRoutes } from "../../src/local/routes/settings.ts";
import { addAssistantFolder, tasksRoutes } from "../../src/local/routes/tasks.ts";
import { buildStatus, type StatusDeps } from "../../src/local/status.ts";
import { TaskManager, type TaskManagerOptions } from "../../src/local/tasks/manager.ts";
import { ensureDataHome } from "../../src/local/write.ts";
import { type CapturedLogs, captureLogs, deferred } from "../fakes.ts";

type Turn = readonly MindChunk[] | ((request: MindRequest) => AsyncIterable<MindChunk>);

const DONE: MindChunk = { type: "done", finishReason: "stop" };

function says(text: string): MindChunk[] {
  return [{ type: "text", text }, DONE];
}

function calls(made: readonly MindToolCall[]): MindChunk[] {
  return [
    { type: "tool-calls", calls: made },
    { type: "done", finishReason: "tool_calls" },
  ];
}

/** A reply that waits for `open`, and fails as a request does once its signal aborts. */
function held(open: Promise<void>, then: readonly MindChunk[] = says("Done.")): Turn {
  return async function* (request) {
    await new Promise<void>((resolve, reject) => {
      if (request.signal.aborted) return reject(request.signal.reason);
      request.signal.addEventListener("abort", () => reject(request.signal.reason), {
        once: true,
      });
      void open.then(resolve);
    });
    yield* then;
  };
}

/** Every task's mind: each request answered from the script for its goal, and billed `cost`. */
class Minds {
  readonly requests: { readonly goal: string; readonly request: MindRequest }[] = [];
  readonly #scripts = new Map<string, readonly Turn[]>();
  readonly #served = new Map<string, number>();
  cost = 0;
  /** What createMind throws instead of making a mind. */
  refuse: Error | null = null;

  script(goal: string, turns: readonly Turn[]): void {
    this.#scripts.set(goal, turns);
  }

  for(goal: string): MindRequest[] {
    return this.requests.filter((each) => each.goal === goal).map((each) => each.request);
  }

  readonly createMind: typeof createMind = (_role, options = {}) => {
    if (this.refuse !== null) throw this.refuse;
    const minds = this;
    return {
      async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
        const goal = /^Goal: (.*)$/m.exec(request.system)?.[1] ?? "";
        minds.requests.push({ goal, request });
        const at = minds.#served.get(goal) ?? 0;
        minds.#served.set(goal, at + 1);
        const turn = minds.#scripts.get(goal)?.[at] ?? says("Done.");
        reportUsage(
          {
            role: "assistant",
            provider: "openrouter",
            model: "test/model",
            units: { inputTokens: 900, outputTokens: 10 },
            costUsd: minds.cost,
          },
          (record) => options.tap?.(record),
        );
        if (typeof turn === "function") yield* turn(request);
        else yield* turn;
      },
    };
  };
}

const AUTH = "Bearer test-secret";
const CHAT = Bun.randomUUIDv7();
const OTHER_CHAT = Bun.randomUUIDv7();
const ORIGIN: TaskChat = { id: CHAT, persona: "milky-green", call: "call-1" };
const ELSEWHERE: TaskChat = { id: OTHER_CHAT, persona: "milky-green", call: "call-2" };

const app: LocalApp = {
  port: () => 0,
  activeCalls: () => 0,
  restart: () => {},
  onStop: () => {},
  memoryAdmin: () => null,
};

let work = "";
let clock = 0;
let settings: AssistantSettings;
/** What the manager reads its settings through: `settings`, or the installed ones. */
let readSettings: () => AssistantSettings;
let problem: string | null = null;
let minds: Minds;
let logs: CapturedLogs;
const managers: TaskManager[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;

function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(() => {
  // A task's web_fetch, or anything else, that reaches for the network fails here instead. The
  // tests' own requests go to their local servers through realFetch.
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`unexpected network call in a test: ${String(input)}`);
  }) as unknown as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  ensureDataHome();
  installSettings();
  work = mkdtempSync(join(tmpdir(), "eidolon-task-routes-"));
  clock = 1_700_000_000_000;
  settings = {
    enabled: true,
    folders: [],
    bash: true,
    spendPauseUsd: 1,
    contextTokens: 128_000,
    permissions: "ask",
  };
  readSettings = () => settings;
  problem = null;
  minds = new Minds();
  logs = captureLogs();
  // What the assistant role names at a start; the tasks' minds are scripted.
  setEnv("ASSISTANT_PROVIDER", "openrouter");
  setEnv("ASSISTANT_MODEL", "test/model");
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const tasks of managers.splice(0)) await tasks.stop();
  logs.restore();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  rmSync(work, { recursive: true, force: true });
  rmSync(tasksDir(), { recursive: true, force: true });
  rmSync(join(dataHome(), "locks"), { recursive: true, force: true });
  rmSync(join(dataHome(), "settings.yaml"), { force: true });
  resetSettings();
});

function manager(overrides: Partial<TaskManagerOptions> = {}): TaskManager {
  const made = new TaskManager({
    dataHome: dataHome(),
    settings: () => readSettings(),
    addFolder: () => {},
    problem: () => problem,
    createMind: minds.createMind,
    now: () => clock,
    report: async () => {},
    ...overrides,
  });
  managers.push(made);
  return made;
}

interface Init {
  readonly body?: unknown;
  /** Sent as it is, in place of `body`. */
  readonly raw?: string;
  readonly auth?: boolean;
}

interface Served {
  readonly tasks: TaskManager;
  call(method: string, path: string, init?: Init): Promise<Response>;
}

/** The task routes and PUT settings, as the local router serves them to the session. */
function serve(
  tasks: TaskManager,
  onAssistantMode: (enabled: boolean) => Promise<void> = (enabled) => tasks.modeChanged(enabled),
): Served {
  const router: RouteHandler = createLocalRouter(
    [...settingsRoutes(app, onAssistantMode), ...tasksRoutes(tasks)],
    (request) => (request.headers.get("authorization") === AUTH ? "bearer" : null),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: { "/api/local/*": router },
    fetch: () => new Response(null, { status: 404 }),
  });
  servers.push(server);
  return {
    tasks,
    call(method, path, init = {}) {
      const headers: Record<string, string> = init.auth === false ? {} : { authorization: AUTH };
      let body: string | undefined;
      if (init.raw !== undefined || init.body !== undefined) {
        headers["content-type"] = "application/json";
        body = init.raw ?? JSON.stringify(init.body);
      }
      return realFetch(`http://127.0.0.1:${server.port}${path}`, { method, headers, body });
    },
  };
}

async function refusal(response: Response): Promise<[number, string]> {
  const body = (await response.json()) as ErrorBody;
  return [response.status, body.error.code];
}

async function json<T>(response: Response): Promise<[number, T]> {
  return [response.status, (await response.json()) as T];
}

async function ids(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  return ((await response.json()) as TasksResponse).tasks.map((task) => task.id);
}

/** Polls `check` until it holds, failing after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

async function reach(tasks: TaskManager, id: string, status: TaskStatus): Promise<TaskSnapshot> {
  await until(async () => (await tasks.get(id)).status === status);
  return tasks.get(id);
}

function transcriptPath(id: string): string {
  return join(tasksDir(), id, "transcript.jsonl");
}

/** A task as a manager or laplace-task left it on disk; `chat: undefined` makes it laplace-task's. */
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
    createdAt: clock,
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

describe("GET tasks", () => {
  test("lists the app's tasks newest first, or one chat's, and never laplace-task's", async () => {
    await seed({ chat: undefined, status: "succeeded", createdAt: clock + 60_000 });
    const { call, tasks } = serve(manager());
    const first = await tasks.start({ goal: "First", folder: join(work, "1") }, ORIGIN);
    clock += 1000;
    const second = await tasks.start({ goal: "Second", folder: join(work, "2") }, ELSEWHERE);
    clock += 1000;
    const third = await tasks.start({ goal: "Third", folder: join(work, "3") }, ORIGIN);

    expect(await ids(await call("GET", "/api/local/tasks"))).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
    expect(await ids(await call("GET", `/api/local/tasks?chat=${CHAT}`))).toEqual([
      third.id,
      first.id,
    ]);
    expect(await ids(await call("GET", `/api/local/tasks?chat=${Bun.randomUUIDv7()}`))).toEqual([]);
    for (const chat of ["", "chat-1", CHAT.toUpperCase()]) {
      expect([chat, await refusal(await call("GET", `/api/local/tasks?chat=${chat}`))]).toEqual([
        chat,
        [400, "bad-request"],
      ]);
    }
  });

  test("GET :id answers the task as it stands", async () => {
    const { call, tasks } = serve(manager());
    const started = await tasks.start({ goal: "Look", folder: join(work, "look") }, ORIGIN);
    const got = await call("GET", `/api/local/tasks/${started.id}`);
    expect(got.headers.get("content-type")).toBe("application/json");
    expect(await json(got)).toEqual([200, started]);
  });

  test("every :id route answers 400 for a malformed id, and 404 for an unknown one or laplace-task's", async () => {
    const cli = await seed({ chat: undefined, status: "running" });
    const { call } = serve(manager());
    const routes: readonly [string, string, unknown?][] = [
      ["GET", ""],
      ["GET", "/events"],
      ["POST", "/approve", { answer: "once" }],
      ["POST", "/continue", {}],
      ["DELETE", ""],
    ];
    for (const [method, suffix, body] of routes) {
      for (const id of ["nope", newTaskId().toUpperCase(), `${newTaskId()}0`, "a%2Fb"]) {
        const response = await call(method, `/api/local/tasks/${id}${suffix}`, { body });
        expect([method, suffix, id, await refusal(response)]).toEqual([
          method,
          suffix,
          id,
          [400, "bad-request"],
        ]);
      }
      for (const id of [newTaskId(), cli.id]) {
        const response = await call(method, `/api/local/tasks/${id}${suffix}`, { body });
        expect([method, suffix, await refusal(response)]).toEqual([
          method,
          suffix,
          [404, "unknown-task"],
        ]);
      }
    }
    // laplace-task may be running it: nothing here touched it.
    expect(await readSnapshot(join(tasksDir(), cli.id))).toEqual(cli);
    expect(readFileSync(transcriptPath(cli.id), "utf8").trimEnd().split("\n")).toHaveLength(1);
  });

  test("every route needs the session", async () => {
    const { call, tasks } = serve(manager());
    const { id } = await tasks.start({ goal: "Private", folder: join(work, "p") }, ORIGIN);
    for (const [method, path, body] of [
      ["GET", "/api/local/tasks"],
      ["GET", `/api/local/tasks/${id}`],
      ["GET", `/api/local/tasks/${id}/events`],
      ["POST", `/api/local/tasks/${id}/approve`, { answer: "deny" }],
      ["POST", `/api/local/tasks/${id}/continue`, {}],
      ["DELETE", `/api/local/tasks/${id}`],
    ] as const) {
      const response = await call(method, path, { body, auth: false });
      expect([method, path, await refusal(response)]).toEqual([
        method,
        path,
        [401, "unauthorized"],
      ]);
    }
    expect((await tasks.get(id)).status).toBe("awaiting-approval");
  });
});

describe("GET :id/events", () => {
  test("streams the transcript from an offset, then each entry while the task runs, and ends when it stops", async () => {
    settings = { ...settings, folders: [work] };
    const open = deferred();
    minds.script("Watch", [held(open.promise, says("Watched."))]);
    const { call, tasks } = serve(manager());
    const { id } = await tasks.start({ goal: "Watch", folder: join(work, "w") }, ORIGIN);
    await until(() => minds.for("Watch").length === 1);

    const live = await call("GET", `/api/local/tasks/${id}/events`);
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toBe("application/x-ndjson");
    const reader = (live.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.endsWith("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the stream ended while the task ran");
      text += decoder.decode(value);
    }
    expect(
      text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line).type),
    ).toEqual(["brief"]);

    // Still open while the run waits: what it stores next comes down the same stream.
    open.resolve();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect((await tasks.get(id)).status).toBe("succeeded");
    expect(text).toBe(readFileSync(transcriptPath(id), "utf8"));
    expect(
      text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line).type),
    ).toEqual(["brief", "assistant", "end"]);

    // From an offset, of a task that no longer runs: the lines after it, and the end.
    const firstLine = Buffer.byteLength(`${text.split("\n")[0]}\n`);
    const rest = await call("GET", `/api/local/tasks/${id}/events?after=${firstLine}`);
    expect([rest.status, await rest.text()]).toEqual([200, text.slice(text.indexOf("\n") + 1)]);
    const size = Buffer.byteLength(text);
    const atEnd = await call("GET", `/api/local/tasks/${id}/events?after=${size}`);
    expect([atEnd.status, await atEnd.text()]).toEqual([200, ""]);

    const past = await call("GET", `/api/local/tasks/${id}/events?after=${size + 1}`);
    expect(await refusal(past)).toEqual([416, "range-not-satisfiable"]);
    for (const after of ["-1", "1.5", "1e3", " 1", "x", "", "1234567890123456"]) {
      const response = await call(
        "GET",
        `/api/local/tasks/${id}/events?after=${encodeURIComponent(after)}`,
      );
      expect([after, await refusal(response)]).toEqual([after, [400, "bad-request"]]);
    }
  });
});

describe("POST :id/approve", () => {
  test("Allow Once runs a task waiting at its start; a second answer finds nothing pending", async () => {
    const open = deferred();
    minds.script("Build", [held(open.promise)]);
    const { call, tasks } = serve(manager());
    const started = await tasks.start({ goal: "Build", folder: join(work, "b") }, ORIGIN);
    expect(started.status).toBe("awaiting-approval");

    // An answer to a question it doesn't ask, as a page showing an older one would send.
    const stale = await call("POST", `/api/local/tasks/${started.id}/approve`, {
      body: { answer: "once", pending: { kind: "path", path: "/x", access: "read" } },
    });
    expect(await refusal(stale)).toEqual([409, "nothing-pending"]);
    const allowed = await call("POST", `/api/local/tasks/${started.id}/approve`, {
      body: { answer: "once", pending: { kind: "start" } },
    });
    expect(await json(allowed)).toEqual([200, expect.objectContaining({ status: "running" })]);
    const again = await call("POST", `/api/local/tasks/${started.id}/approve`, {
      body: { answer: "once" },
    });
    expect(await refusal(again)).toEqual([409, "nothing-pending"]);
    open.resolve();
    await reach(tasks, started.id, "succeeded");
  });

  test("Allow is refused while Assistant Mode is off or not ready; Deny still ends the task", async () => {
    const { call, tasks } = serve(manager());
    const { id } = await tasks.start({ goal: "Later", folder: join(work, "l") }, ORIGIN);
    const approve = (answer: string) =>
      call("POST", `/api/local/tasks/${id}/approve`, { body: { answer } });

    settings = { ...settings, enabled: false };
    expect(await refusal(await approve("once"))).toEqual([409, "assistant-off"]);
    expect(await refusal(await approve("always"))).toEqual([409, "assistant-off"]);
    settings = { ...settings, enabled: true };
    problem = "OpenRouter needs a model: set ASSISTANT_MODEL";
    const notReady = await approve("once");
    expect([notReady.status, ((await notReady.json()) as ErrorBody).error]).toEqual([
      409,
      { code: "assistant-not-ready", message: problem },
    ]);
    expect((await tasks.get(id)).status).toBe("awaiting-approval");
    expect(minds.requests).toEqual([]);

    settings = { ...settings, enabled: false };
    const denied = await approve("deny");
    expect(await json(denied)).toEqual([
      200,
      expect.objectContaining({
        status: "cancelled",
        denied: true,
        outcome: { status: "cancelled" },
      }),
    ]);
  });

  test("a body that isn't an answer is 400, one over 16 KB 413, and a model createMind refuses 400", async () => {
    const { call, tasks } = serve(manager());
    const started = await tasks.start({ goal: "Pick", folder: join(work, "pick") }, ORIGIN);
    const approve = (init: Init) =>
      call("POST", `/api/local/tasks/${started.id}/approve`, init).then(refusal);

    expect(await approve({ raw: "{" })).toEqual([400, "bad-json"]);
    expect(await approve({})).toEqual([400, "bad-json"]);
    for (const body of [
      null,
      [],
      { answer: "maybe" },
      { answer: "once", web: "sometimes" },
      { answer: "once", model: { account: "openrouter" } },
      { answer: "once", pending: "start" },
    ]) {
      expect([body, await approve({ body })]).toEqual([body, [400, "bad-request"]]);
    }
    expect(await approve({ body: { answer: "once", note: "x".repeat(16 * 1024) } })).toEqual([
      413,
      "payload-too-large",
    ]);
    expect(
      await approve({
        body: { answer: "once", model: { account: "no-such-account", model: "m" } },
      }),
    ).toEqual([400, "unknown-account"]);
    minds.refuse = new ProviderConfigError(
      "OpenRouter needs an API key: set OPENROUTER_API_KEY in credentials.json or the environment",
    );
    expect(
      await approve({ body: { answer: "once", model: { account: "openrouter", model: "x/y" } } }),
    ).toEqual([400, "bad-request"]);
    expect(await tasks.get(started.id)).toEqual(started);
  });

  test("Always Allow saves the folder in settings.yaml, once; a folder its list can't hold is refused", async () => {
    const { call, tasks } = serve(
      manager({ addFolder: (folder) => addAssistantFolder(app, folder) }),
    );
    const folder = join(work, "site");
    // As a hand-written settings.yaml may spell it: the same folder, so it isn't added twice.
    writeFileSync(
      join(dataHome(), "settings.yaml"),
      `assistant:\n  folders:\n    - ${join(work, "kept")}\n    - ${folder}/\n`,
    );
    installSettings();
    const site = await tasks.start({ goal: "Site", folder }, ORIGIN);
    const always = await call("POST", `/api/local/tasks/${site.id}/approve`, {
      body: { answer: "always" },
    });
    expect(await json(always)).toEqual([200, expect.objectContaining({ status: "running" })]);
    expect(assistantSettings().folders).toEqual([join(work, "kept"), folder]);

    const fresh = join(work, "fresh");
    addAssistantFolder(app, fresh);
    // Installed again at once: the next run's grants read it.
    expect(assistantSettings().folders).toEqual([join(work, "kept"), folder, fresh]);
    addAssistantFolder(app, fresh);
    expect(assistantSettings().folders).toEqual([join(work, "kept"), folder, fresh]);

    // The list is split on commas and each part trimmed: these would come back as other folders,
    // /a for /a,b. A path approval's folder can end in a space: it is the parent of the path asked.
    const comma = join(work, "a,b");
    const started = await tasks.start({ goal: "Comma", folder: comma }, ORIGIN);
    const refused = await call("POST", `/api/local/tasks/${started.id}/approve`, {
      body: { answer: "always" },
    });
    expect(await refusal(refused)).toEqual([400, "bad-request"]);
    expect((await tasks.get(started.id)).status).toBe("awaiting-approval");
    const once = await call("POST", `/api/local/tasks/${started.id}/approve`, {
      body: { answer: "once" },
    });
    expect(once.status).toBe(200);
    // Each trimmed away by one of the two trims the setting is read back through.
    for (const end of [" ", "\ufeff", "\x1f"]) {
      expect(() => addAssistantFolder(app, join(work, `spaced${end}`))).toThrow(
        "its path has a comma, or whitespace at an end",
      );
    }
    expect(assistantSettings().folders).toEqual([join(work, "kept"), folder, fresh]);
  });

  test("Always Allow with a settings.yaml that doesn't parse answers 409 and changes nothing", async () => {
    const { call, tasks } = serve(
      manager({ addFolder: (folder) => addAssistantFolder(app, folder) }),
    );
    const broken = "assistant: [unclosed\n";
    writeFileSync(join(dataHome(), "settings.yaml"), broken);
    const started = await tasks.start({ goal: "Broken", folder: join(work, "x") }, ORIGIN);
    const always = await call("POST", `/api/local/tasks/${started.id}/approve`, {
      body: { answer: "always" },
    });
    expect(await refusal(always)).toEqual([409, "conflict"]);
    expect(await tasks.get(started.id)).toEqual(started);
    expect(readFileSync(join(dataHome(), "settings.yaml"), "utf8")).toBe(broken);
    expect(minds.requests).toEqual([]);
  });

  test("a command's question is answered by its call and command, and the longest command a card shows fits the body", async () => {
    settings = { ...settings, folders: [work] };
    // The longest a card shows: its JSON is just under 12 KB, three bytes to each CJK character.
    const command = `echo ${"好".repeat(4093)}`;
    minds.script("Long", [
      calls([{ id: "b1", name: "bash", arguments: { command } }]),
      says("Printed it."),
    ]);
    const { call, tasks } = serve(manager());
    const { id } = await tasks.start({ goal: "Long", folder: join(work, "long") }, ORIGIN);
    const asked = (await reach(tasks, id, "paused")).pending;
    expect(asked).toEqual({ kind: "command", call: "b1", command, timeout: 120 });

    const other = await call("POST", `/api/local/tasks/${id}/approve`, {
      body: { answer: "once", pending: { ...asked, call: "b2" } },
    });
    expect(await refusal(other)).toEqual([409, "nothing-pending"]);
    const body = { answer: "always", pending: asked };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(16 * 1024);
    const allowed = await call("POST", `/api/local/tasks/${id}/approve`, { body });
    expect(await json(allowed)).toEqual([200, expect.objectContaining({ status: "running" })]);
    await reach(tasks, id, "succeeded");
    expect((await tasks.allowedCommands()).map((each) => each.command)).toEqual([command]);
  });
});

describe("assistant/commands", () => {
  /** Allows `command` for good in `folder`, as Always on a task's card does. */
  async function allow(tasks: TaskManager, goal: string, folder: string, command: string) {
    minds.script(goal, [calls([{ id: "b1", name: "bash", arguments: { command } }]), says("Ran.")]);
    const { id } = await tasks.start({ goal, folder }, ORIGIN);
    await reach(tasks, id, "paused");
    await tasks.approve(id, { answer: "always" });
    await reach(tasks, id, "succeeded");
    return id;
  }

  test("GET lists the commands allowed for good, newest first; DELETE takes one back, answering with the rest", async () => {
    settings = { ...settings, folders: [work] };
    const { call, tasks } = serve(manager());
    expect(await json(await call("GET", "/api/local/assistant/commands"))).toEqual([
      200,
      { commands: [] },
    ]);
    const first = await allow(tasks, "First", join(work, "one"), "echo one");
    clock += 1000;
    const second = await allow(tasks, "Second", join(work, "two"), "echo two");

    const [status, listed] = await json<AllowedCommandsResponse>(
      await call("GET", "/api/local/assistant/commands"),
    );
    expect(status).toBe(200);
    expect(listed.commands.map(({ command, task, folder }) => [command, task, folder])).toEqual([
      ["echo two", second, realpathSync(join(work, "two"))],
      ["echo one", first, realpathSync(join(work, "one"))],
    ]);
    const [newest, oldest] = listed.commands;
    const removed = await call("DELETE", `/api/local/assistant/commands/${newest?.id}`);
    expect(await json(removed)).toEqual([200, { commands: [oldest] }]);
    expect(await json(await call("GET", "/api/local/assistant/commands"))).toEqual([
      200,
      { commands: [oldest] },
    ]);
  });

  test("DELETE answers 400 for an id that is none, 404 for one no command has; both need the session", async () => {
    const { call } = serve(manager());
    for (const id of ["x", "commands", `${Bun.randomUUIDv7()}`.toUpperCase()]) {
      const malformed = await call("DELETE", `/api/local/assistant/commands/${id}`);
      expect([id, await refusal(malformed)]).toEqual([id, [400, "bad-request"]]);
    }
    const unknown = await call("DELETE", `/api/local/assistant/commands/${Bun.randomUUIDv7()}`);
    expect(await refusal(unknown)).toEqual([404, "unknown-command"]);
    for (const [method, path] of [
      ["GET", "/api/local/assistant/commands"],
      ["DELETE", `/api/local/assistant/commands/${Bun.randomUUIDv7()}`],
    ] as const) {
      const response = await call(method, path, { auth: false });
      expect([method, await refusal(response)]).toEqual([method, [401, "unauthorized"]]);
    }
  });
});

describe("POST :id/continue", () => {
  test("goes on from a spend pause with a new pause amount; a task not paused, or waiting on an answer, is refused", async () => {
    const granted = join(work, "granted");
    settings = { ...settings, folders: [granted] };
    minds.cost = 0.6;
    const ls = { id: "l1", name: "ls", arguments: { path: "." } };
    const open = deferred();
    minds.script("Spend", [
      calls([ls]),
      calls([{ ...ls, id: "l2" }]),
      held(open.promise, says("Spent it.")),
    ]);
    const { call, tasks } = serve(manager());
    const proceed = (id: string, init: Init = { body: {} }) =>
      call("POST", `/api/local/tasks/${id}/continue`, init);

    const waiting = await tasks.start({ goal: "Wait", folder: join(work, "outside") }, ORIGIN);
    expect(await refusal(await proceed(waiting.id))).toEqual([409, "pending"]);

    const { id } = await tasks.start({ goal: "Spend", folder: join(granted, "spend") }, ORIGIN);
    const paused = await reach(tasks, id, "paused");
    expect(paused.pause?.reason).toBe("spend");
    for (const body of [{ spendPauseUsd: -1 }, { spendPauseUsd: "5" }, null]) {
      expect([body, await refusal(await proceed(id, { body }))]).toEqual([
        body,
        [400, "bad-request"],
      ]);
    }
    expect(await refusal(await proceed(id, { raw: "nope" }))).toEqual([400, "bad-json"]);
    settings = { ...settings, enabled: false };
    expect(await refusal(await proceed(id))).toEqual([409, "assistant-off"]);
    settings = { ...settings, enabled: true };
    problem = "No key";
    expect(await refusal(await proceed(id))).toEqual([409, "assistant-not-ready"]);
    problem = null;
    expect((await tasks.get(id)).status).toBe("paused");

    const continued = await proceed(id, { body: { spendPauseUsd: 5 } });
    expect(await json(continued)).toEqual([
      200,
      expect.objectContaining({ status: "running", spendPauseUsd: 5 }),
    ]);
    expect(await refusal(await proceed(id))).toEqual([409, "not-paused"]);
    open.resolve();
    await reach(tasks, id, "succeeded");
    expect(await refusal(await proceed(id))).toEqual([409, "not-paused"]);
  });
});

describe("DELETE :id", () => {
  test("stops a live task, even with Assistant Mode off, and answers an ended one as it is", async () => {
    settings = { ...settings, folders: [work] };
    minds.script("Stop me", [held(new Promise(() => {}))]);
    const { call, tasks } = serve(manager());
    const { id } = await tasks.start({ goal: "Stop me", folder: join(work, "s") }, ORIGIN);
    await until(() => minds.for("Stop me").length === 1);

    settings = { ...settings, enabled: false };
    const [status, stopped] = await json<TaskSnapshot>(
      await call("DELETE", `/api/local/tasks/${id}`),
    );
    expect(status).toBe(200);
    expect(stopped).toMatchObject({ status: "cancelled", outcome: { status: "cancelled" } });
    expect(minds.for("Stop me")[0]?.signal.aborted).toBe(true);

    const [again, ended] = await json<TaskSnapshot>(await call("DELETE", `/api/local/tasks/${id}`));
    expect([again, ended.status, ended.endedAt]).toEqual([200, "cancelled", stopped.endedAt]);
  });

  test("while laplace-task holds a task, approve, continue and Stop answer 409 task-locked", async () => {
    const interrupted = await seed({ status: "interrupted" });
    const { call, tasks } = serve(manager());
    const waiting = await tasks.start({ goal: "Held", folder: join(work, "held") }, ORIGIN);
    const releases = [waiting.id, interrupted.id].map((id) =>
      acquireLock(`task:${id}`, "laplace-task"),
    );
    try {
      const approve = await call("POST", `/api/local/tasks/${waiting.id}/approve`, {
        body: { answer: "once" },
      });
      expect(await refusal(approve)).toEqual([409, "task-locked"]);
      const proceed = await call("POST", `/api/local/tasks/${interrupted.id}/continue`, {
        body: {},
      });
      expect(await refusal(proceed)).toEqual([409, "task-locked"]);
      for (const id of [waiting.id, interrupted.id]) {
        expect(await refusal(await call("DELETE", `/api/local/tasks/${id}`))).toEqual([
          409,
          "task-locked",
        ]);
      }
    } finally {
      for (const release of releases) release();
    }
    expect((await tasks.get(waiting.id)).status).toBe("awaiting-approval");
    expect((await tasks.get(interrupted.id)).status).toBe("interrupted");
  });
});

describe("PUT settings", () => {
  test("turning Assistant Mode off stops every live task before it answers; nothing else does", async () => {
    readSettings = assistantSettings;
    minds.script("Running", [held(new Promise(() => {}))]);
    const tasks = manager();
    const modes: boolean[] = [];
    const { call } = serve(tasks, (enabled) => {
      modes.push(enabled);
      return tasks.modeChanged(enabled);
    });
    const put = (values: Record<string, unknown>) =>
      call("PUT", "/api/local/settings", { body: { scope: "app", values } });

    const running = await tasks.start({ goal: "Running", folder: join(work, "r") }, ORIGIN);
    await call("POST", `/api/local/tasks/${running.id}/approve`, { body: { answer: "once" } });
    await until(() => minds.for("Running").length === 1);
    const waiting = await tasks.start({ goal: "Waiting", folder: join(work, "w") }, ELSEWHERE);

    expect((await put({ "assistant.spendPauseUsd": 2 })).status).toBe(200);
    expect(modes).toEqual([]);
    expect((await tasks.get(running.id)).status).toBe("running");

    expect((await put({ "assistant.enabled": false })).status).toBe(200);
    expect(modes).toEqual([false]);
    for (const id of [running.id, waiting.id]) {
      expect(await tasks.get(id)).toMatchObject({
        status: "cancelled",
        outcome: { status: "cancelled" },
      });
    }
    expect(minds.for("Running")[0]?.signal.aborted).toBe(true);

    // Only a change of the mode the server runs with is news.
    expect((await put({ "assistant.enabled": false })).status).toBe(200);
    expect((await put({ "assistant.enabled": true })).status).toBe(200);
    expect(modes).toEqual([false, true]);
    setEnv("ASSISTANT_ENABLED", "true");
    expect((await put({ "assistant.enabled": false })).status).toBe(200);
    expect(assistantSettings().enabled).toBe(true);
    expect(modes).toEqual([false, true]);
  });
});

describe("GET status", () => {
  test("assistant.running counts the app's tasks that are running", async () => {
    setEnv("OPENROUTER_API_KEY", "test-key");
    const granted = join(work, "granted");
    settings = { ...settings, folders: [granted] };
    const open = deferred();
    minds.script("Busy", [held(open.promise)]);
    const { tasks } = serve(manager());
    const deps: StatusDeps = {
      fetch: (async () => {
        throw new Error("status probed the network");
      }) as unknown as typeof fetch,
      now: Date.now,
    };
    expect(buildStatus(app, deps, tasks).assistant.running).toBe(0);

    const { id } = await tasks.start({ goal: "Busy", folder: join(granted, "busy") }, ORIGIN);
    await tasks.start({ goal: "Asks", folder: join(work, "asks") }, ORIGIN);
    expect(buildStatus(app, deps, tasks).assistant).toEqual({
      enabled: true,
      ready: true,
      problem: null,
      running: 1,
      search: { on: false, problem: null },
      kinds: { quick: null, coding: null, research: null },
    });
    open.resolve();
    await reach(tasks, id, "succeeded");
    expect(buildStatus(app, deps, tasks).assistant.running).toBe(0);
  });
});
