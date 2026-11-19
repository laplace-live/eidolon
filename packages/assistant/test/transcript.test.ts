import "../../config/test/isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "@eidolon/config";
import type { TaskEntryDraft } from "@eidolon/engine";
import {
  newTaskId,
  openTaskStore,
  readSnapshot,
  type TaskSnapshot,
  tasksDir,
  writeSnapshot,
} from "../src/transcript.ts";

afterEach(() => rmSync(dataHome(), { recursive: true, force: true }));

const brief = {
  goal: "写一个 React TodoMVC",
  deliverable: "index.html",
  folder: "/Users/me/todo",
  check: "adding, ticking and deleting work",
};

const drafts: TaskEntryDraft[] = [
  { type: "brief", brief },
  {
    type: "assistant",
    text: "Looking first.",
    calls: [{ id: "c1", name: "ls", arguments: { path: "." } }],
  },
  { type: "tool-start", callId: "c1", name: "ls" },
  { type: "tool-result", callId: "c1", name: "ls", content: "(empty)", isError: false },
];

function taskDir(): string {
  return join(tasksDir(), newTaskId());
}

const chat = {
  id: "0196f3a0-7c1e-7d2a-9b4c-1f2e3d4c5b6a",
  persona: "milky-green",
  call: "call_start_1",
};

function snapshot(id: string): TaskSnapshot {
  return {
    v: 1,
    id,
    createdAt: 1_763_251_200_000,
    status: "running",
    brief,
    model: { account: "openrouter", model: "z-ai/glm-5" },
    grants: [{ path: "/Users/me/Git", access: "read" }],
    spendPauseUsd: 1,
    spentUsd: 0.25,
    files: { read: [], written: ["/Users/me/todo/index.html"] },
  };
}

describe("tasks' folders", () => {
  test("tasks live in the data home, under time-ordered UUIDv7 ids", async () => {
    expect(tasksDir()).toBe(join(dataHome(), "tasks"));
    const first = newTaskId();
    await Bun.sleep(2);
    const second = newTaskId();
    for (const id of [first, second]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(first < second).toBe(true);
  });
});

describe("openTaskStore", () => {
  test("entries are numbered after the last one, stamped, and read back in order", async () => {
    const dir = taskDir();
    const store = openTaskStore(dir);
    expect(await store.entries()).toEqual([]);
    const before = Date.now();
    const stored = [];
    for (const draft of drafts) stored.push(await store.append(draft));
    expect(stored.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    for (const [i, entry] of stored.entries()) {
      expect(entry).toMatchObject(drafts[i] as object);
      expect(entry.at).toBeGreaterThanOrEqual(before);
      expect(entry.at).toBeLessThanOrEqual(Date.now());
    }
    expect(await store.entries()).toEqual(stored);
    const lines = readFileSync(join(dir, "transcript.jsonl"), "utf8").split("\n");
    expect(lines.pop()).toBe("");
    expect(lines.map((line) => Object.keys(JSON.parse(line)).slice(0, 3))).toEqual(
      Array(4).fill(["seq", "at", "type"]),
    );
  });

  test("a store opened on a transcript numbers after its last entry", async () => {
    const dir = taskDir();
    const first = openTaskStore(dir);
    await first.append({ type: "brief", brief });
    await first.append({ type: "pause", reason: "spend", detail: "$1.00 spent" });
    const reopened = openTaskStore(dir);
    expect(await reopened.append({ type: "resume" })).toMatchObject({ seq: 3, type: "resume" });
    expect((await openTaskStore(dir).entries()).map((entry) => entry.type)).toEqual([
      "brief",
      "pause",
      "resume",
    ]);
  });

  test("appends made together are stored one at a time, numbered in the order made", async () => {
    const dir = taskDir();
    const store = openTaskStore(dir);
    const appended = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.append({ type: "steer", text: `line ${i}` })),
    );
    expect(appended.map((entry) => entry.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const entries = await openTaskStore(dir).entries();
    expect(entries.map((entry) => (entry.type === "steer" ? entry.text : ""))).toEqual(
      Array.from({ length: 12 }, (_, i) => `line ${i}`),
    );
  });

  test("a torn last line is ignored, and the next entry takes its place", async () => {
    for (const torn of ['{"seq":3,"at":1,"type":"assis', '{"seq":3,"at":1,"type":"resume"}']) {
      const dir = taskDir();
      const store = openTaskStore(dir);
      await store.append({ type: "brief", brief });
      await store.append({ type: "steer", text: "use Vue instead" });
      appendFileSync(join(dir, "transcript.jsonl"), torn);
      const reopened = openTaskStore(dir);
      expect((await reopened.entries()).map((entry) => entry.seq)).toEqual([1, 2]);
      expect(await reopened.append({ type: "resume" })).toMatchObject({ seq: 3 });
      const lines = readFileSync(join(dir, "transcript.jsonl"), "utf8").trimEnd().split("\n");
      expect(lines.map((line) => JSON.parse(line).type)).toEqual(["brief", "steer", "resume"]);
    }
  });

  test("a broken line before the last is an error, not a skipped entry", async () => {
    const dir = taskDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "transcript.jsonl"), 'not json\n{"seq":2,"at":1,"type":"resume"}\n');
    const store = openTaskStore(dir);
    await expect(store.entries()).rejects.toThrow(
      `${join(dir, "transcript.jsonl")}: line 1 is not JSON`,
    );
    await expect(store.append({ type: "resume" })).rejects.toThrow("line 1 is not JSON");
  });

  test("the task's folders are 0700 and its files 0600, whatever the umask", async () => {
    const umask = process.umask(0o022);
    try {
      const dir = taskDir();
      await openTaskStore(dir).append({ type: "brief", brief });
      await writeSnapshot(dir, snapshot("t1"));
      for (const folder of [tasksDir(), dir]) expect(statSync(folder).mode & 0o777).toBe(0o700);
      for (const name of ["transcript.jsonl", "task.json"]) {
        expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
      }
    } finally {
      process.umask(umask);
    }
  });
});

describe("task.json", () => {
  test("a snapshot written whole reads back, with no temp file left", async () => {
    const dir = taskDir();
    expect(await readSnapshot(dir)).toBeNull();
    await writeSnapshot(dir, snapshot("t1"));
    const ended: TaskSnapshot = {
      ...snapshot("t1"),
      status: "succeeded",
      endedAt: 1_763_251_260_000,
      outcome: { status: "succeeded", report: "index.html is ready" },
    };
    await writeSnapshot(dir, ended);
    expect(await readSnapshot(dir)).toEqual(ended);
    expect(readdirSync(dir)).toEqual(["task.json"]);
  });

  test("what it waits on, its pause, plan, latest step, inbox and web access read back", async () => {
    const dir = taskDir();
    const unpriced =
      "No price is known for qwen3 at openai-compatible, so its spend can't count toward the pause at every $1.00.";
    const snapshots: TaskSnapshot[] = [
      {
        ...snapshot("t1"),
        status: "awaiting-approval",
        pending: { kind: "start" },
        web: { mode: "ask", hosts: [], denied: [] },
      },
      {
        ...snapshot("t1"),
        status: "paused",
        pending: {
          kind: "path",
          path: "/Users/me/Documents/a.txt",
          access: "read",
          folder: "/Users/me/Documents",
        },
        todo: [
          { text: "Read the notes", status: "in_progress" },
          { text: "Write index.html", status: "pending" },
        ],
        step: { tool: "read", head: "/Users/me/Documents/a.txt" },
        inbox: { steer: ["use Vue instead"], followUp: [] },
      },
      {
        ...snapshot("t1"),
        status: "paused",
        pending: { kind: "fetch", host: "react.dev" },
        web: { mode: "ask", hosts: ["developer.mozilla.org"], denied: ["example.com"] },
      },
      {
        ...snapshot("t1"),
        status: "paused",
        pause: { reason: "unpriced", detail: unpriced },
        outcome: { status: "paused", reason: "unpriced", detail: unpriced },
        web: { mode: "off", hosts: [], denied: [] },
      },
      {
        ...snapshot("t1"),
        status: "cancelled",
        denied: true,
        endedAt: 1_763_251_260_000,
        outcome: { status: "cancelled" },
      },
    ];
    for (const value of snapshots) {
      await writeSnapshot(dir, value);
      expect(await readSnapshot(dir)).toEqual(value);
    }
  });

  test("its kind, the skills she named, its command question, the commands it was refused or runs in the background, and its outside reading read back", async () => {
    const dir = taskDir();
    const background = [{ id: 2, command: "npm run dev", startedAt: 1_000, endsAt: 121_000 }];
    const snapshots: TaskSnapshot[] = [
      {
        ...snapshot("t1"),
        status: "paused",
        profile: "coding",
        skills: ["house-style", "deploy"],
        pending: { kind: "command", call: "call_9", command: "npm test", timeout: 120 },
        bash: { denied: ["rm -rf build"] },
        paths: { denied: ["/x/notes"] },
        background,
      },
      {
        ...snapshot("t1"),
        status: "paused",
        profile: "research",
        pending: {
          kind: "command",
          call: "call_9",
          command: "npm test",
          timeout: 1800,
          granted: true,
          review: "send",
        },
        external: true,
      },
      {
        ...snapshot("t1"),
        status: "awaiting-approval",
        pending: { kind: "start", review: "failed" },
      },
    ];
    for (const value of snapshots) {
      await writeSnapshot(dir, value);
      expect(await readSnapshot(dir)).toEqual(value);
    }
  });

  test("its MCP question, the calls it was refused, and the servers and tools it works without read back", async () => {
    const dir = taskDir();
    const asked = {
      kind: "mcp",
      server: "fs",
      tool: "write_file",
      call: "call_3",
      key: "0123456789abcdef0123456789abcdef",
      args: [
        { name: "path", head: "~/.zshrc", chars: 8, lines: 1 },
        { name: "content", head: "x".repeat(300), chars: 3000, lines: 40 },
      ],
    } as const;
    const snapshots: TaskSnapshot[] = [
      {
        ...snapshot("t1"),
        status: "paused",
        pending: { ...asked, hint: "destructive" },
        mcp: { denied: ["fedcba9876543210fedcba9876543210"] },
      },
      {
        ...snapshot("t1"),
        status: "paused",
        pending: { ...asked, args: [] },
        mcp: {
          denied: [],
          failed: [{ server: "github", error: "github needs GITHUB_TOKEN" }, { error: "bad file" }],
          left: [{ server: "big", count: 12 }],
        },
      },
    ];
    for (const value of snapshots) {
      await writeSnapshot(dir, value);
      expect(await readSnapshot(dir)).toEqual(value);
    }
  });

  test("the chat she started it from, and its report stored there, read back", async () => {
    const dir = taskDir();
    const snapshots: TaskSnapshot[] = [
      { ...snapshot("t1"), chat },
      {
        ...snapshot("t1"),
        status: "succeeded",
        chat,
        reported: true,
        endedAt: 1_763_251_260_000,
        outcome: { status: "succeeded", report: "index.html is ready" },
      },
    ];
    for (const value of snapshots) {
      await writeSnapshot(dir, value);
      expect(await readSnapshot(dir)).toEqual(value);
    }
  });

  test("a file that isn't a version 1 snapshot is an error", async () => {
    const dir = taskDir();
    const path = join(dir, "task.json");
    await writeSnapshot(dir, snapshot("t1"));
    const wrong: unknown[] = [
      { ...snapshot("t1"), v: 2 },
      { ...snapshot("t1"), status: "done" },
      { ...snapshot("t1"), grants: [{ path: "/x", access: "write" }] },
      { ...snapshot("t1"), files: { read: [] } },
      { ...snapshot("t1"), brief: { goal: "x" } },
      { ...snapshot("t1"), pending: { kind: "folder" } },
      { ...snapshot("t1"), pending: { kind: "path", path: "/x", access: "read-write" } },
      { ...snapshot("t1"), pending: { kind: "path", path: "/x/y", access: "read", folder: 7 } },
      { ...snapshot("t1"), pending: { kind: "fetch" } },
      { ...snapshot("t1"), pending: { kind: "fetch", host: "a.b", review: "risky" } },
      { ...snapshot("t1"), pending: { kind: "start", review: null } },
      { ...snapshot("t1"), pause: { reason: "bored", detail: "" } },
      { ...snapshot("t1"), pause: { reason: "spend" } },
      { ...snapshot("t1"), todo: [{ text: "x", status: "doing" }] },
      { ...snapshot("t1"), todo: { items: [] } },
      { ...snapshot("t1"), step: "write" },
      { ...snapshot("t1"), step: { tool: "write" } },
      { ...snapshot("t1"), step: { tool: 7, head: "index.html" } },
      { ...snapshot("t1"), inbox: { steer: ["x"] } },
      { ...snapshot("t1"), inbox: { steer: [1], followUp: [] } },
      { ...snapshot("t1"), web: { mode: "some", hosts: [], denied: [] } },
      { ...snapshot("t1"), web: { mode: "ask", hosts: "react.dev", denied: [] } },
      { ...snapshot("t1"), denied: false },
      { ...snapshot("t1"), chat: chat.id },
      { ...snapshot("t1"), chat: { id: chat.id, persona: chat.persona } },
      { ...snapshot("t1"), chat: { ...chat, persona: 7 } },
      { ...snapshot("t1"), reported: false },
      { ...snapshot("t1"), profile: "other" },
      { ...snapshot("t1"), profile: "Coding" },
      { ...snapshot("t1"), skills: "house-style" },
      { ...snapshot("t1"), skills: [7] },
      { ...snapshot("t1"), pending: { kind: "command", call: "c", command: "ls" } },
      { ...snapshot("t1"), pending: { kind: "command", command: "ls", timeout: 120 } },
      {
        ...snapshot("t1"),
        pending: { kind: "command", call: "c", command: "ls", timeout: 120, granted: false },
      },
      { ...snapshot("t1"), bash: { denied: "ls" } },
      { ...snapshot("t1"), bash: {} },
      { ...snapshot("t1"), paths: { denied: "/x" } },
      { ...snapshot("t1"), paths: {} },
      { ...snapshot("t1"), background: [{ id: 1, command: "ls", startedAt: 1 }] },
      { ...snapshot("t1"), background: [{ id: "1", command: "ls", startedAt: 1, endsAt: 2 }] },
      { ...snapshot("t1"), external: false },
      {
        ...snapshot("t1"),
        pending: { kind: "mcp", server: "fs", tool: "read", call: "c", args: [] },
      },
      {
        ...snapshot("t1"),
        pending: { kind: "mcp", server: "fs", tool: "read", call: "c", key: "k", args: "path" },
      },
      {
        ...snapshot("t1"),
        pending: {
          kind: "mcp",
          server: "fs",
          tool: "read",
          call: "c",
          key: "k",
          args: [{ name: "path", head: "a", chars: "1", lines: 1 }],
        },
      },
      {
        ...snapshot("t1"),
        pending: {
          kind: "mcp",
          server: "fs",
          tool: "read",
          call: "c",
          key: "k",
          args: [],
          hint: "safe",
        },
      },
      { ...snapshot("t1"), mcp: {} },
      { ...snapshot("t1"), mcp: { denied: [], failed: [{ server: "fs" }] } },
      { ...snapshot("t1"), mcp: { denied: [], left: [{ server: "fs", count: 1.5 }] } },
    ];
    for (const value of wrong) {
      await Bun.write(path, JSON.stringify(value));
      await expect(readSnapshot(dir)).rejects.toThrow(`${path} is not a version 1 task snapshot`);
    }
    await Bun.write(path, "{");
    await expect(readSnapshot(dir)).rejects.toThrow(`${path} is not JSON`);
  });
});
