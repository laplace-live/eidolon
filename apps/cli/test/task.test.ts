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
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, tasksDir } from "@eidolon/assistant";
import { dataHome } from "@eidolon/config";
import type { createMind, MindChunk, MindRequest, MindToolCall, TaskEntry } from "@eidolon/engine";
import { acquireLock, LockedError } from "@eidolon/ingest";
import {
  ProviderConfigError,
  ProviderHttpError,
  reportUsage,
  type UsageRecord,
} from "@eidolon/providers";
import { ArgparseExit } from "../src/argparse.ts";
import { parseTaskArgs, Spend, taskMain } from "../src/task.ts";
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
 */
function scripted(turns: readonly Turn[], costUsd = 0) {
  const made: { role: string; options: Parameters<typeof createMind>[1] }[] = [];
  const requests: MindRequest[] = [];
  const records: UsageRecord[] = [];
  const factory: typeof createMind = (role = "mind", options = {}) => {
    made.push({ role, options });
    return {
      async *stream(request: MindRequest): AsyncGenerator<MindChunk> {
        const turn = turns[requests.length] ?? says("Done.");
        requests.push(request);
        reportUsage(
          {
            role: "assistant",
            provider: "openrouter",
            model: "test/model",
            units: { inputTokens: 900, cachedTokens: 100, outputTokens: 10 },
            costUsd,
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
    expect(first?.tools.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
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
      json: true,
    });
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

  test("-h says it ignores Assistant Mode, and how it exits", () => {
    let help = "";
    try {
      parseTaskArgs(["-h"]);
    } catch (error) {
      if (!(error instanceof ArgparseExit)) throw error;
      expect(error.code).toBe(0);
      help = error.stdout;
    }
    expect(help).toStartWith("usage: laplace-task [-h]");
    expect(help).toContain("Assistant Mode (assistant.enabled) governs the local app");
    expect(help).toContain("It exits 0 when the task succeeded, 1 when it failed, 3 when it");
  });
});

describe("Spend", () => {
  const record = (fields: Partial<UsageRecord>): UsageRecord => ({
    role: "assistant",
    provider: "openrouter",
    model: "test/model",
    units: {},
    category: "llm",
    at: 0,
    source: "task",
    session: "t",
    costUsd: null,
    costSource: "unpriced",
    ...fields,
  });

  test("sums the records' costs from where the task stood, and warns once of one it can't price", () => {
    const meter = new Spend(0.5);
    meter.tap(record({ costUsd: 0.25, costSource: "reported" }));
    meter.tap(record({}));
    meter.tap(record({}));
    meter.tap(record({ costUsd: 0.1, costSource: "estimated" }));
    expect(meter.spentUsd()).toBeCloseTo(0.85, 10);
    expect(logs.records.filter(([level]) => level === "WARNING")).toEqual([
      [
        "WARNING",
        "No price is known for test/model at openrouter, so the task's spend pauses can't count it",
      ],
    ]);
  });

  test("counts the last request's whole input, what its provider cached included", () => {
    const meter = new Spend(0);
    expect(meter.lastInputTokens()).toBeNull();
    meter.tap(record({ units: { inputTokens: 300, cachedTokens: 9000, cacheWriteTokens: 700 } }));
    expect(meter.lastInputTokens()).toBe(10_000);
    meter.tap(record({ units: { inputTokens: 40, outputTokens: 5 } }));
    expect(meter.lastInputTokens()).toBe(40);
    meter.tap(record({ units: { outputTokens: 5 } }));
    expect(meter.lastInputTokens()).toBeNull();
  });
});
