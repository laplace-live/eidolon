import { expect, test } from "bun:test";
import { createTaskTools, type PathGuard } from "../src/index.ts";

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
