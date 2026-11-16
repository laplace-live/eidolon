import { describe, expect, it } from "bun:test";
import type { TaskToolResult } from "@eidolon/engine";
import { createTodoTool, TODO_STATUSES } from "../src/tools/todo.ts";
import { toolContext } from "./tool-folder.ts";

const todoTool = createTodoTool();

function todo(args: Record<string, unknown>): Promise<TaskToolResult> {
  return todoTool.execute(args, toolContext());
}

describe("todo tool", () => {
  it("renders the list it is given, and hands the items on as details", async () => {
    const items = [
      { text: "Scaffold index.html", status: "done" },
      { text: "Wire up the filters", status: "in_progress" },
      { text: "Check it in a browser", status: "pending" },
    ];

    expect(await todo({ items })).toEqual({
      content:
        "Todo list (1/3 done):\n[x] Scaffold index.html\n[>] Wire up the filters\n[ ] Check it in a browser",
      details: { items },
    });
  });

  it("replaces the list whole on each call", async () => {
    await todo({
      items: [
        { text: "One", status: "done" },
        { text: "Two", status: "pending" },
      ],
    });

    expect(await todo({ items: [{ text: "Three", status: "pending" }] })).toEqual({
      content: "Todo list (0/1 done):\n[ ] Three",
      details: { items: [{ text: "Three", status: "pending" }] },
    });
  });

  it("clears the list with no items", async () => {
    expect(await todo({ items: [] })).toEqual({
      content: "Todo list cleared",
      details: { items: [] },
    });
  });

  it("trims each step's text", async () => {
    const result = await todo({ items: [{ text: "  Write tests\n", status: "pending" }] });

    expect(result.details).toEqual({ items: [{ text: "Write tests", status: "pending" }] });
  });

  it("answers a malformed list as pi's validation does, naming each bad item", async () => {
    for (const [items, problems] of [
      [undefined, ["items: missing"]],
      ['[{"text":"a","status":"done"}]', ["items: expected array, got string"]],
      [
        ["Write tests", null],
        ["items.0: expected object, got string", "items.1: expected object, got null"],
      ],
      [[{ text: "a", status: "done" }, { status: "pending" }], ["items.1.text: missing"]],
      [[{ text: " ", status: "pending" }], ["items.0.text: must not be empty"]],
      [
        [{ text: 3, status: "completed" }],
        [
          "items.0.text: expected string, got integer",
          "items.0.status: must be one of pending, in_progress, done",
        ],
      ],
    ] as const) {
      const result = await todo({ items });
      expect(result.isError).toBe(true);
      expect(result.content).toStartWith(
        `Validation failed for tool "todo":\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n\n`,
      );
    }
  });

  it("offers the statuses it accepts, and replays safely", () => {
    const items = todoTool.schema.properties.items as {
      items: { properties: { status: { enum: readonly string[] } } };
    };

    expect(items.items.properties.status.enum).toEqual([...TODO_STATUSES]);
    expect(todoTool.schema.required).toEqual(["items"]);
    expect(todoTool.replay).toBe("safe");
    expect(todoTool.guidelines.join(" ")).toContain("todo list");
  });
});
