// A task's MCP servers through the manager, on a scripted mind and the fake stdio server, with no
// network: each call's card and its answers, when Always applies, what mcp.json's switches do to a
// running task, and that every way a task ends kills its servers.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mcpCallKey,
  REVIEW_SYSTEM,
  readSnapshot,
  type TaskChat,
  type TaskPending,
  type TaskSnapshot,
  type TaskStatus,
  tasksDir,
} from "@eidolon/assistant";
import type { PermissionLevel } from "@eidolon/chat";
import { type AssistantSettings, dataHome } from "@eidolon/config";
import type { createMind, MindChunk, MindRequest, MindToolCall, TaskEntry } from "@eidolon/engine";
import { reportUsage } from "@eidolon/providers";
import {
  TaskManager,
  type TaskManagerOptions,
  TaskRefused,
} from "../../src/local/tasks/manager.ts";
import { ensureDataHome } from "../../src/local/write.ts";
import { type CapturedLogs, captureLogs, deferred } from "../fakes.ts";

const FIXTURE = join(
  import.meta.dir,
  "../../../../packages/assistant/test/fixtures/mcp-server.mjs",
);

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

function call(id: string, name: string, args: Record<string, unknown>): MindToolCall {
  return { id, name, arguments: args };
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

/**
 * Every task's mind: each request answered from its task's script, found by the goal, and each of
 * Approve for Me's reviews by `review`.
 */
class Minds {
  readonly requests: { readonly goal: string; readonly request: MindRequest }[] = [];
  /** Each review's prompt. */
  readonly reviewed: string[] = [];
  /** A review's reply to its prompt. Default: an allow. */
  review: (prompt: string) => string = () => '{"verdict":"allow"}';
  readonly #scripts = new Map<string, readonly Turn[]>();
  readonly #served = new Map<string, number>();

  script(goal: string, turns: readonly Turn[]): void {
    this.#scripts.set(goal, turns);
  }

  for(goal: string): MindRequest[] {
    return this.requests.filter((each) => each.goal === goal).map((each) => each.request);
  }

  readonly createMind: typeof createMind = (_role, options = {}) => {
    const minds = this;
    return {
      async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
        if (request.system === REVIEW_SYSTEM) {
          const prompt = (request.messages as { content: string }[])
            .map((m) => m.content)
            .join("\n");
          minds.reviewed.push(prompt);
          yield* says(minds.review(prompt));
          return;
        }
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
            costUsd: 0,
          },
          (record) => options.tap?.(record),
        );
        if (typeof turn === "function") yield* turn(request);
        else yield* turn;
      },
    };
  };
}

const ORIGIN: TaskChat = { id: "chat-1", persona: "milky-green", call: "call-1" };
const ECHO = "mcp__fake__echo";
const FAIL = "mcp__fake__fail";

let work = "";
let umask = 0;
let settings: AssistantSettings;
let minds: Minds;
let logs: CapturedLogs;
const managers: TaskManager[] = [];
/** Every fake server's pid, so a test that fails can't leave one running. */
const spawned = new Set<number>();
const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;

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
  work = mkdtempSync(join(tmpdir(), "eidolon-tasks-mcp-"));
  settings = {
    enabled: true,
    folders: [work],
    bash: true,
    spendPauseUsd: 1,
    contextTokens: 128_000,
    permissions: "ask",
  };
  minds = new Minds();
  logs = captureLogs();
  for (const [name, value] of [
    ["ASSISTANT_PROVIDER", "openrouter"],
    ["ASSISTANT_MODEL", "test/model"],
  ] as const) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
});

afterEach(async () => {
  for (const tasks of managers.splice(0)) await tasks.stop();
  for (const pid of spawned) {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
  spawned.clear();
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

function manager(overrides: Partial<TaskManagerOptions> = {}): TaskManager {
  const made = new TaskManager({
    dataHome: dataHome(),
    settings: () => settings,
    addFolder: () => {},
    problem: () => null,
    createMind: minds.createMind,
    report: async () => {},
    ...overrides,
  });
  managers.push(made);
  return made;
}

async function booted(): Promise<TaskManager> {
  const tasks = manager();
  await tasks.boot();
  return tasks;
}

/** The fake server's entry: its flags, then mcp.json's own fields. */
function fake(flags: readonly string[] = [], fields: Record<string, unknown> = {}) {
  return { command: process.execPath, args: ["--no-env-file", FIXTURE, ...flags], ...fields };
}

const MCP_JSON = () => join(dataHome(), "mcp.json");

/** mcp.json's reference to a secret named `name`. */
const ref = (name: string): string => `\${${name}}`;

function writeMcp(servers: Record<string, unknown>): void {
  writeFileSync(MCP_JSON(), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

function readMcp(): { mcpServers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(MCP_JSON(), "utf8"));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The fake server's pid once its --pidfile names it. */
async function pidOf(file: string): Promise<number> {
  await until(() => existsSync(file) && readFileSync(file, "utf8") !== "");
  const [pid] = JSON.parse(readFileSync(file, "utf8")) as [number];
  spawned.add(pid);
  return pid;
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

async function reach(
  tasks: TaskManager,
  id: string,
  ...statuses: TaskStatus[]
): Promise<TaskSnapshot> {
  let snapshot = await tasks.get(id);
  await until(async () => {
    snapshot = await tasks.get(id);
    return statuses.includes(snapshot.status);
  });
  return snapshot;
}

function transcript(id: string): TaskEntry[] {
  const path = join(tasksDir(), id, "transcript.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as TaskEntry);
}

/** Each call the task started, by its id. */
function started(id: string): string[] {
  return transcript(id).flatMap((entry) => (entry.type === "tool-start" ? [entry.callId] : []));
}

/** Each tool result the task stored, as [call id, content]. */
function results(id: string): [string, string][] {
  return transcript(id).flatMap((entry) =>
    entry.type === "tool-result" ? [[entry.callId, entry.content] as [string, string]] : [],
  );
}

async function refused(work: Promise<unknown>): Promise<TaskRefused> {
  try {
    await work;
  } catch (error) {
    if (error instanceof TaskRefused) return error;
    throw error;
  }
  throw new Error("expected the manager to refuse");
}

/** The card's question for echo saying `text` in call `id`. */
function echoAsked(id: string, text: string): TaskPending {
  return {
    kind: "mcp",
    server: "fake",
    tool: "echo",
    call: id,
    key: mcpCallKey(ECHO, { text }),
    args: [{ name: "text", head: text, chars: text.length, lines: text === "" ? 0 : 1 }],
    hint: "read-only",
  };
}

const echo = (id: string, text: string) => call(id, ECHO, { text });

describe("a call's card", () => {
  test("waits before the call reaches the server, naming the server, the tool, every argument with its size, and the server's hint", async () => {
    writeMcp({ fake: fake([], { tools: ["echo", "nested"] }) });
    const tree = { label: "root", children: [{ label: "a" }] };
    minds.script("Ask", [calls([call("m1", "mcp__fake__nested", { tree })])]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Ask", folder: join(work, "ask") }, ORIGIN);

    const paused = await reach(tasks, id, "paused");
    expect(paused.pending).toEqual({
      kind: "mcp",
      server: "fake",
      tool: "nested",
      call: "m1",
      key: mcpCallKey("mcp__fake__nested", { tree }),
      args: [
        { name: "tree", head: JSON.stringify(tree), chars: JSON.stringify(tree).length, lines: 1 },
      ],
      hint: "destructive",
    });
    expect(paused.pause).toEqual({
      reason: "approval",
      detail: "run nested on the MCP server fake",
    });
    expect(started(id)).toEqual([]);
    const offered = minds.for("Ask")[0]?.tools.map((tool) => tool.name);
    expect(offered?.slice(-3)).toEqual(["todo", ECHO, "mcp__fake__nested"]);
  });

  test("a tool the server says only reads asks all the same", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    minds.script("Reads", [calls([echo("m1", "hi")])]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Reads", folder: join(work, "reads") }, ORIGIN);
    expect((await reach(tasks, id, "paused")).pending).toEqual(echoAsked("m1", "hi"));
  });

  test("a call with many long arguments still lists every one, each cut shorter, its answer under the route's 16 KB", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    const args: Record<string, unknown> = { text: "hi" };
    for (let n = 0; n < 60; n++) args[`part${n}`] = "奶".repeat(400);
    minds.script("Many", [calls([call("m1", ECHO, args)])]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Many", folder: join(work, "many") }, ORIGIN);

    const { pending } = await reach(tasks, id, "paused");
    if (pending?.kind !== "mcp") throw new Error("expected an MCP question");
    expect(pending.args.map((arg) => arg.name).sort()).toEqual(Object.keys(args).sort());
    expect(pending.args.find((arg) => arg.name === "part0")).toMatchObject({ chars: 400 });
    expect(pending.args.every((arg) => arg.head.length < 300)).toBe(true);
    const body = JSON.stringify({ answer: "always", pending });
    expect(Buffer.byteLength(body)).toBeLessThan(16 * 1024);
  });

  test("a call whose argument names alone can't fit on the card is refused unasked", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    const args: Record<string, unknown> = { text: "hi" };
    for (let n = 0; n < 40; n++) args[`${"k".repeat(400)}${n}`] = 1;
    minds.script("Crowded", [calls([call("m1", ECHO, args)]), says("Gave up.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Crowded", folder: join(work, "crowd") }, ORIGIN);

    const ended = await reach(tasks, id, "succeeded");
    expect(ended.pending).toBeUndefined();
    expect(results(id)).toEqual([
      [
        "m1",
        "This call has too many arguments, or names too long, to show the owner on the task's card. Make it with fewer.",
      ],
    ]);
    expect(started(id)).toEqual([]);
  });
});

describe("the answers", () => {
  test("Run Once runs that call; the next call asks again, even one reusing its id and arguments", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    minds.script("Once", [calls([echo("m1", "hi")]), calls([echo("m1", "hi")]), says("Done.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Once", folder: join(work, "once") }, ORIGIN);
    await reach(tasks, id, "paused");

    const answered = await tasks.approve(id, { answer: "once", pending: echoAsked("m1", "hi") });
    expect(answered).toMatchObject({ status: "running" });
    expect((await reach(tasks, id, "paused")).pending).toEqual(echoAsked("m1", "hi"));
    expect(results(id)).toEqual([["m1", "hi"]]);

    await tasks.approve(id, { answer: "once" });
    await reach(tasks, id, "succeeded");
    expect(results(id)).toEqual([
      ["m1", "hi"],
      ["m1", "hi"],
    ]);
    expect(readMcp().mcpServers.fake?.alwaysAllow).toBeUndefined();
  });

  test("three calls in one reply take three cards, each Run Once kept through the next card's pause, and each runs once", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    minds.script("Three", [calls([echo("a", "1"), echo("b", "2"), echo("c", "3")]), says("Done.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Three", folder: join(work, "three") }, ORIGIN);

    const asked: string[] = [];
    for (const [each, text] of [
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ] as const) {
      const paused = await reach(tasks, id, "paused");
      expect(paused.pending).toEqual(echoAsked(each, text));
      asked.push(each);
      expect(started(id)).toEqual([]);
      await tasks.approve(id, { answer: "once", pending: echoAsked(each, text) });
    }
    await reach(tasks, id, "succeeded");
    expect(asked).toEqual(["a", "b", "c"]);
    expect(started(id)).toEqual(["a", "b", "c"]);
    expect(results(id).sort()).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
  });

  test("Always runs the call and adds the tool to its server's alwaysAllow; its later calls run unasked, in this task and the next", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"], description: "A fake" }) });
    minds.script("Always", [
      calls([echo("m1", "hi")]),
      calls([echo("m2", "again")]),
      says("Done."),
    ]);
    minds.script("Next", [calls([echo("n1", "there")]), says("Done.")]);
    const tasks = await booted();
    const first = await tasks.start({ goal: "Always", folder: join(work, "always") }, ORIGIN);
    await reach(tasks, first.id, "paused");

    await tasks.approve(first.id, { answer: "always", pending: echoAsked("m1", "hi") });
    // The first call's result is the server's: from then on the task has read outside content.
    const after = await reach(tasks, first.id, "succeeded", "paused");
    expect(after.pending).toEqual(echoAsked("m2", "again"));
    expect(readMcp().mcpServers.fake).toMatchObject({
      alwaysAllow: ["echo"],
      description: "A fake",
    });
    expect(statSync(MCP_JSON()).mode & 0o777).toBe(0o600);

    const next = await tasks.start({ goal: "Next", folder: join(work, "next") }, ORIGIN);
    await reach(tasks, next.id, "succeeded");
    expect(results(next.id)).toEqual([["n1", "there"]]);
  });

  test("Deny refuses the call and the run goes on; the same arguments later are refused unasked, others ask, and no refusal reads as outside content", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    minds.script("Deny", [
      calls([echo("m1", "no")]),
      calls([echo("m2", "no")]),
      calls([echo("m3", "yes")]),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Deny", folder: join(work, "deny") }, ORIGIN);
    await reach(tasks, id, "paused");

    const denied = await tasks.approve(id, { answer: "deny", pending: echoAsked("m1", "no") });
    expect(denied.mcp).toEqual({ denied: [mcpCallKey(ECHO, { text: "no" })] });
    const paused = await reach(tasks, id, "paused");
    expect(paused.pending).toEqual(echoAsked("m3", "yes"));
    const refusal =
      "The owner refused this call to echo on the MCP server fake; don't make it again with the same arguments.";
    expect(results(id)).toEqual([
      ["m1", refusal],
      ["m2", refusal],
    ]);
    expect(started(id)).toEqual([]);
    expect(paused.external).toBeUndefined();
  });

  test("a Run Once whose call a steering line skipped lets no later call reusing its id through", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    const write = (id: string) => call(id, "write", { path: `${id}.txt`, content: "x" });
    minds.script("Skipped", [
      // write runs alone, so its batch goes one call at a time, and a steering line skips the rest.
      calls([write("w1"), echo("m1", "hi"), write("w2")]),
      calls([echo("m1", "hi")]),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Skipped", folder: join(work, "skipped") }, ORIGIN);
    expect((await reach(tasks, id, "paused")).pending).toEqual(echoAsked("m1", "hi"));
    await tasks.steer(id, "Stop and read the notes first.");
    await tasks.approve(id, { answer: "once", pending: echoAsked("m1", "hi") });

    // The first m1 never ran, and the second asks.
    expect((await reach(tasks, id, "paused")).pending).toEqual(echoAsked("m1", "hi"));
    expect(started(id)).toEqual(["w1"]);
  });

  test("an answer naming another call, or other arguments, is refused, and the card stands", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    minds.script("Named", [calls([echo("m1", "one")])]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Named", folder: join(work, "named") }, ORIGIN);
    await reach(tasks, id, "paused");
    for (const asked of [echoAsked("m0", "one"), echoAsked("m1", "two")]) {
      const wrong = await refused(tasks.approve(id, { answer: "once", pending: asked }));
      expect([wrong.status, wrong.code]).toEqual([409, "nothing-pending"]);
    }
    expect((await tasks.get(id)).pending).toEqual(echoAsked("m1", "one"));
  });

  test("Always while mcp.json doesn't parse is refused, saying so, and the task still asks", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    minds.script("Broken", [calls([echo("m1", "hi")])]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Broken", folder: join(work, "broken") }, ORIGIN);
    await reach(tasks, id, "paused");
    writeFileSync(MCP_JSON(), "{ not json");

    const always = await refused(
      tasks.approve(id, { answer: "always", pending: echoAsked("m1", "hi") }),
    );
    expect([always.status, always.code]).toEqual([409, "invalid-mcp-config"]);
    expect(readFileSync(MCP_JSON(), "utf8")).toBe("{ not json");
    expect(await tasks.get(id)).toMatchObject({ status: "paused", pending: echoAsked("m1", "hi") });
  });

  test("Always while mcp.json links to another client's config is refused, and neither file changes", async () => {
    // The shared file another client keeps, which honors the same alwaysAllow.
    const shared = join(work, "cline_mcp_settings.json");
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    renameSync(MCP_JSON(), shared);
    symlinkSync(shared, MCP_JSON());
    const text = readFileSync(shared, "utf8");
    minds.script("Linked", [calls([echo("m1", "hi")])]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Linked", folder: join(work, "linked") }, ORIGIN);
    await reach(tasks, id, "paused");

    const always = await refused(
      tasks.approve(id, { answer: "always", pending: echoAsked("m1", "hi") }),
    );
    expect([always.status, always.code]).toEqual([409, "linked-mcp-config"]);
    expect(lstatSync(MCP_JSON()).isSymbolicLink()).toBe(true);
    expect(readFileSync(shared, "utf8")).toBe(text);
    expect(await tasks.get(id)).toMatchObject({ status: "paused", pending: echoAsked("m1", "hi") });
    // Run Once still runs it.
    await tasks.approve(id, { answer: "once", pending: echoAsked("m1", "hi") });
    await until(() => results(id).length === 1);
    expect(results(id)).toEqual([["m1", "hi"]]);
  });
});

describe("when Always applies", () => {
  test("not under No Web: a tool the owner always allows asks, and Always on its card runs that call", async () => {
    writeMcp({ fake: fake([], { tools: ["echo", "fail"], alwaysAllow: ["echo"] }) });
    minds.script("Offline", [
      calls([echo("m1", "hi")]),
      calls([call("m2", FAIL, {})]),
      says("Done."),
    ]);
    // Outside assistant.folders, so its start waits on the card, where the owner picks No Web.
    settings = { ...settings, folders: [] };
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Offline", folder: join(work, "offline") }, ORIGIN);
    await tasks.approve(id, { answer: "once", pending: { kind: "start" }, web: "off" });

    const paused = await reach(tasks, id, "paused");
    expect(paused.pending).toEqual(echoAsked("m1", "hi"));
    expect(paused.web?.mode).toBe("off");
    expect(paused.external).toBeUndefined();
    await tasks.approve(id, { answer: "always", pending: echoAsked("m1", "hi") });
    await until(() => results(id).length === 1);
    expect(results(id)).toEqual([["m1", "hi"]]);
    expect(readMcp().mcpServers.fake?.alwaysAllow).toEqual(["echo"]);
  });

  test("not once the task has read outside content, an MCP server's error included", async () => {
    writeMcp({ fake: fake([], { tools: ["echo", "fail"], alwaysAllow: ["echo", "fail"] }) });
    minds.script("Tainted", [calls([call("m1", FAIL, {})]), calls([echo("m2", "later")])]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Tainted", folder: join(work, "tainted") }, ORIGIN);

    const paused = await reach(tasks, id, "paused");
    expect(paused.pending).toEqual(echoAsked("m2", "later"));
    expect(paused.external).toBe(true);
    expect(results(id)).toEqual([["m1", "it broke"]]);
  });
});

describe("permission levels", () => {
  test("Full Access runs a call unasked, but a task under No Web still asks", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    let level: PermissionLevel = "ask";
    minds.script("Full", [calls([echo("m1", "hi")]), says("Done.")]);
    minds.script("Full offline", [calls([echo("m2", "there")]), says("Done.")]);
    settings = { ...settings, folders: [] };
    const tasks = manager({ permissions: async () => level });
    await tasks.boot();
    const offline = await tasks.start(
      { goal: "Full offline", folder: join(work, "offline") },
      ORIGIN,
    );
    await tasks.approve(offline.id, { answer: "once", pending: { kind: "start" }, web: "off" });
    level = "full";
    expect((await reach(tasks, offline.id, "paused")).pending).toEqual(echoAsked("m2", "there"));

    const { id } = await tasks.start({ goal: "Full", folder: join(work, "full") }, ORIGIN);
    await reach(tasks, id, "succeeded");
    expect(results(id)).toEqual([["m1", "hi"]]);
    expect(minds.reviewed).toEqual([]);
  });

  test("Approve for Me reviews a call with its arguments: an allow runs it, an ask says why", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    minds.review = (prompt) =>
      prompt.includes("secret") ? '{"verdict":"ask","risk":"send"}' : '{"verdict":"allow"}';
    minds.script("Auto", [calls([echo("m1", "hi")]), calls([echo("m2", "secret")])]);
    const tasks = manager({ permissions: async () => "auto" });
    await tasks.boot();
    const { id } = await tasks.start({ goal: "Auto", folder: join(work, "auto") }, ORIGIN);

    const paused = await reach(tasks, id, "paused");
    expect(paused.pending).toEqual({ ...echoAsked("m2", "secret"), review: "send" });
    expect(results(id)).toEqual([["m1", "hi"]]);
    expect(minds.reviewed[0]).toContain(
      JSON.stringify({ kind: "mcp", server: "fake", tool: "echo", hint: "read-only" }),
    );
    expect(minds.reviewed[0]?.split("\n").at(-1)).toBe(JSON.stringify({ text: "hi" }));
  });

  test("Approve for Me asks about a call too long to review whole, with no review", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"] }) });
    minds.script("Long", [calls([echo("m1", "z".repeat(9000))])]);
    const tasks = manager({ permissions: async () => "auto" });
    await tasks.boot();
    const { id } = await tasks.start({ goal: "Long", folder: join(work, "long") }, ORIGIN);
    const paused = await reach(tasks, id, "paused");
    expect(paused.pending).toMatchObject({ kind: "mcp", tool: "echo", review: "unclear" });
    expect(minds.reviewed).toEqual([]);
  });
});

describe("mcp.json's switches on a running task", () => {
  test("a server turned off, or taken out, has its next call refused unasked", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"], alwaysAllow: ["echo"] }) });
    const turnedOff = deferred();
    const takenOut = deferred();
    minds.script("Off", [
      calls([echo("m1", "on")]),
      held(turnedOff.promise, calls([echo("m2", "off")])),
      held(takenOut.promise, calls([echo("m3", "gone")])),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Off", folder: join(work, "off") }, ORIGIN);
    await until(() => results(id).length === 1);

    await tasks.changeMcpServer("fake", { enabled: false });
    turnedOff.resolve();
    await until(() => results(id).length === 2);
    writeMcp({});
    takenOut.resolve();
    await reach(tasks, id, "succeeded");
    const off = "The owner turned off the MCP server fake; don't call its tools again.";
    expect(results(id)).toEqual([
      ["m1", "on"],
      ["m2", off],
      ["m3", off],
    ]);
  });

  test("Always taken back in Settings asks at the next call", async () => {
    writeMcp({ fake: fake([], { tools: ["echo"], alwaysAllow: ["echo"] }) });
    const revoked = deferred();
    minds.script("Revoked", [held(revoked.promise, calls([echo("m1", "hi")]))]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Revoked", folder: join(work, "revoked") }, ORIGIN);
    await until(() => minds.for("Revoked").length === 1);

    await tasks.changeMcpServer("fake", { revoke: "echo" });
    revoked.resolve();
    expect((await reach(tasks, id, "paused")).pending).toEqual(echoAsked("m1", "hi"));
    expect(readMcp().mcpServers.fake).not.toHaveProperty("alwaysAllow");
  });
});

describe("the servers' lives", () => {
  test("start at the task's first run in the data home's mcp folder, live through its pauses, and die once it ends", async () => {
    const pidfile = join(work, "fake.pid");
    writeMcp({ fake: fake(["--child", "--pidfile", pidfile], { tools: ["echo", "env"] }) });
    minds.script("Lives", [
      calls([call("m1", "mcp__fake__env", {})]),
      calls([echo("m2", "still here")]),
      says("Done."),
    ]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Lives", folder: join(work, "lives") }, ORIGIN);
    await reach(tasks, id, "paused");
    const [pid, child] = JSON.parse(readFileSync(pidfile, "utf8")) as [number, number];
    spawned.add(pid);
    spawned.add(child);

    await tasks.approve(id, { answer: "once" });
    await reach(tasks, id, "paused");
    expect([alive(pid), alive(child)]).toEqual([true, true]);
    const env = JSON.parse(results(id)[0]?.[1] ?? "{}") as { cwd: string; names: string[] };
    expect(env.cwd).toBe(realpathSync(join(dataHome(), "mcp")));
    expect(statSync(join(dataHome(), "mcp")).mode & 0o777).toBe(0o700);
    expect(env.names).not.toContain("ASSISTANT_PROVIDER");

    await tasks.approve(id, { answer: "once" });
    await reach(tasks, id, "succeeded");
    await until(() => !alive(pid) && !alive(child));
    expect(results(id).at(-1)).toEqual(["m2", "still here"]);
  });

  test("Stop, a deleted chat and Assistant Mode off each kill a paused task's servers", async () => {
    const tasks = await booted();
    for (const [n, end] of [
      [1, (id: string) => tasks.cancel(id)],
      [2, () => tasks.cancelChat(ORIGIN.id)],
      [3, () => tasks.modeChanged(false)],
    ] as const) {
      settings = { ...settings, enabled: true };
      const pidfile = join(work, `fake-${n}.pid`);
      writeMcp({ fake: fake(["--pidfile", pidfile], { tools: ["echo"] }) });
      minds.script(`End ${n}`, [calls([echo("m1", "hi")])]);
      const { id } = await tasks.start({ goal: `End ${n}`, folder: join(work, `end${n}`) }, ORIGIN);
      await reach(tasks, id, "paused");
      const pid = await pidOf(pidfile);
      expect(alive(pid)).toBe(true);

      if (n === 3) settings = { ...settings, enabled: false };
      await end(id);
      expect((await tasks.get(id)).status).toBe("cancelled");
      await until(() => !alive(pid));
    }
  });

  test("the server's stop kills them, and the task, resumed at the next start, starts its servers anew", async () => {
    const pidfile = join(work, "fake.pid");
    writeMcp({ fake: fake(["--pidfile", pidfile], { tools: ["echo"], alwaysAllow: ["echo"] }) });
    minds.script("Resumed", [
      held(new Promise(() => {})),
      calls([echo("m1", "back")]),
      says("Done."),
    ]);
    const first = await booted();
    const { id } = await first.start({ goal: "Resumed", folder: join(work, "resumed") }, ORIGIN);
    const before = await pidOf(pidfile);
    await until(() => minds.for("Resumed").length === 1);

    await first.stop();
    expect(alive(before)).toBe(false);
    expect((await readSnapshot(join(tasksDir(), id)))?.status).toBe("interrupted");

    rmSync(pidfile);
    const second = await booted();
    const after = await pidOf(pidfile);
    expect(after).not.toBe(before);
    await reach(second, id, "succeeded");
    expect(results(id)).toEqual([["m1", "back"]]);
  });

  test("Stop while a server hangs starting ends the task within a second, its process group gone, and no server failed", async () => {
    const pidfile = join(work, "hang.pid");
    writeMcp({ slow: fake(["--hang", "--child", "--pidfile", pidfile], { timeout: 30 }) });
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Hang", folder: join(work, "hang") }, ORIGIN);
    const pid = await pidOf(pidfile);
    const [, child] = JSON.parse(readFileSync(pidfile, "utf8")) as [number, number];
    spawned.add(child);

    const at = Date.now();
    const stopped = await tasks.cancel(id);
    expect(Date.now() - at).toBeLessThan(1000);
    expect(stopped.status).toBe("cancelled");
    expect(stopped).not.toHaveProperty("mcp");
    await until(() => !alive(pid) && !alive(child), 1000);
    expect(minds.for("Hang")).toEqual([]);
  });

  test("turning Assistant Mode off while a server hangs starting answers within a second", async () => {
    const pidfile = join(work, "hang.pid");
    writeMcp({ slow: fake(["--hang", "--pidfile", pidfile], { timeout: 30 }) });
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Hang", folder: join(work, "hang") }, ORIGIN);
    const pid = await pidOf(pidfile);

    settings = { ...settings, enabled: false };
    const at = Date.now();
    await tasks.modeChanged(false);
    expect(Date.now() - at).toBeLessThan(1000);
    expect((await tasks.get(id)).status).toBe("cancelled");
    await until(() => !alive(pid), 1000);
  });

  test("a server that can't start, a disabled one and a broken entry leave the task its other servers, the card saying why", async () => {
    writeMcp({
      fake: fake([], { tools: ["echo"] }),
      locked: fake(["--pidfile", join(work, "never.pid")], {
        env: { TOKEN: ref("MISSING_TOKEN") },
      }),
      off: fake(["--pidfile", join(work, "off.pid")], { enabled: false }),
      broken: { command: "x", cwd: "relative" },
    });
    minds.script("Partial", [calls([echo("m1", "hi")])]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Partial", folder: join(work, "partial") }, ORIGIN);

    const paused = await reach(tasks, id, "paused");
    expect(paused.pending).toEqual(echoAsked("m1", "hi"));
    expect(paused.mcp).toEqual({
      denied: [],
      failed: [
        {
          server: "broken",
          error: 'server "broken": cwd must be an absolute path or start with ~/',
        },
        {
          server: "locked",
          error:
            "locked needs MISSING_TOKEN: set it in credentials.json's mcpSecrets or in the environment",
        },
      ],
    });
    expect(existsSync(join(work, "never.pid"))).toBe(false);
    expect(existsSync(join(work, "off.pid"))).toBe(false);
    expect(minds.for("Partial")[0]?.tools.filter((tool) => tool.name.startsWith("mcp__"))).toEqual([
      expect.objectContaining({ name: ECHO }),
    ]);
  });

  test("an mcp.json that doesn't parse starts no server and fails nothing: the task runs without them, its card saying why", async () => {
    writeFileSync(MCP_JSON(), "{ not json");
    minds.script("Unparsed", [says("Done without them.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "Unparsed", folder: join(work, "unparsed") }, ORIGIN);

    const ended = await reach(tasks, id, "succeeded");
    expect(ended.mcp).toEqual({
      denied: [],
      failed: [{ error: `${MCP_JSON()} isn't valid JSON` }],
    });
    expect(minds.for("Unparsed")[0]?.tools.some((tool) => tool.name.startsWith("mcp__"))).toBe(
      false,
    );
  });

  test("a task with no mcp.json has no MCP tools and nothing on its card", async () => {
    minds.script("None", [says("Done.")]);
    const tasks = await booted();
    const { id } = await tasks.start({ goal: "None", folder: join(work, "none") }, ORIGIN);
    const ended = await reach(tasks, id, "succeeded");
    expect(ended).not.toHaveProperty("mcp");
    expect(existsSync(join(dataHome(), "mcp"))).toBe(false);
  });
});
