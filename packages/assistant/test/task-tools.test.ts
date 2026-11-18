import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BashJobs,
  buildTaskPrompt,
  createTaskTools,
  type PathGuard,
  type Skill,
  type TaskToolsOptions,
  type WebSearcher,
} from "../src/index.ts";

test("a task's tools, in the order its prompt lists them, each with its prompt's snippet", () => {
  const guard: PathGuard = { folder: "/tmp/task", resolve: async (path) => path };
  const tools = createTaskTools(guard);
  expect(tools.map((tool) => tool.schema.name)).toEqual([
    "read",
    "write",
    "edit",
    "ls",
    "find",
    "grep",
    "todo",
  ]);
  for (const tool of tools)
    expect([tool.schema.name, tool.snippet]).not.toEqual([tool.schema.name, ""]);
  // A restart that caught an edit mid-way can't tell whether it landed; the others run again.
  expect(tools.filter((tool) => tool.replay === "never").map((tool) => tool.schema.name)).toEqual([
    "edit",
  ]);
});

describe("a task's skill and web_search", () => {
  const guard: PathGuard = { folder: "/tmp/task", resolve: async (path) => path };
  const web = { allows: () => false };
  const search: WebSearcher = async () => ({ results: [], engine: "exa", searches: 1 });
  const skill: Skill = {
    name: "house-style",
    description: "The owner's house style.",
    source: "owner",
    dir: "/tmp/skills/house-style",
  };
  const names = (options: TaskToolsOptions) =>
    createTaskTools(guard, options).map((tool) => tool.schema.name);

  test("skill comes after grep, and web_search after web_fetch, in the order the prompt lists them", () => {
    expect(names({ web, search, skills: [skill] })).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
      "skill",
      "web_fetch",
      "web_search",
      "todo",
    ]);
  });

  test("no skills, no skill tool; no search, or no web, no web_search", () => {
    expect(names({ web, search, skills: [] })).not.toContain("skill");
    expect(names({ web })).not.toContain("web_search");
    // No Web leaves out both.
    expect(names({ search, skills: [skill] })).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
      "skill",
      "todo",
    ]);
  });
});

describe("a task's bash tools", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const guard: PathGuard = { folder: "/tmp/task", resolve: async (path) => path };
  let jobs: BashJobs;
  let records: string;

  beforeAll(async () => {
    records = mkdtempSync(join(tmpdir(), "task-tools-bash-"));
    jobs = await BashJobs.open(records);
  });

  afterAll(() => {
    if (platform) Object.defineProperty(process, "platform", platform);
    rmSync(records, { recursive: true, force: true });
  });

  test("come after grep, as bash, bash_output and bash_kill, only when the task has commands", () => {
    const names = (tools: readonly { schema: { name: string } }[]) =>
      tools.map((t) => t.schema.name);
    expect(names(createTaskTools(guard, { bash: jobs }))).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
      "bash",
      "bash_output",
      "bash_kill",
      "todo",
    ]);
    expect(names(createTaskTools(guard))).not.toContain("bash");
  });

  test("are never offered on Windows", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const names = createTaskTools(guard, { bash: jobs }).map((tool) => tool.schema.name);
      expect(names.filter((name) => name.startsWith("bash"))).toEqual([]);
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
  });

  test("put their snippets and bash's guidelines in the worker's prompt", () => {
    const tools = createTaskTools(guard, { bash: jobs });
    const prompt = buildTaskPrompt({
      brief: {
        goal: "Run the tests",
        deliverable: "A report",
        folder: "/tmp/task",
        check: "Green",
      },
      tools,
      contextFiles: [],
      date: "2026-11-17",
      folder: "/tmp/task",
    });
    expect(prompt).toContain(
      "- bash: Run commands with bash: tests, builds, git, package managers",
    );
    expect(prompt).toContain("- bash_output: Show a command's output");
    expect(prompt).toContain("- bash_kill: Stop a command running in the background");
    const bash = tools.find((tool) => tool.schema.name === "bash");
    for (const rule of bash?.guidelines ?? []) expect(prompt).toContain(`- ${rule}`);
    expect(bash?.guidelines.length).toBe(7);
  });
});
