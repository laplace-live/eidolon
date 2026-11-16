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

function snapshot(id: string): TaskSnapshot {
  return {
    v: 1,
    id,
    createdAt: 1_763_251_200_000,
    status: "running",
    persona: "milky-green",
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
    ];
    for (const value of wrong) {
      await Bun.write(path, JSON.stringify(value));
      await expect(readSnapshot(dir)).rejects.toThrow(`${path} is not a version 1 task snapshot`);
    }
    await Bun.write(path, "{");
    await expect(readSnapshot(dir)).rejects.toThrow(`${path} is not JSON`);
  });
});
