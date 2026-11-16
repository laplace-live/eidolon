// The task's plan: the worker keeps it as a todo list, and the owner sees it on the task's card.
import type { AssistantTool } from "../types.ts";
import { invalidArguments, typeName } from "./results.ts";

export const TODO_STATUSES = ["pending", "in_progress", "done"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  readonly text: string;
  readonly status: TodoStatus;
}

export interface TodoDetails {
  readonly items: readonly TodoItem[];
}

const MARKS: Readonly<Record<TodoStatus, string>> = {
  pending: "[ ]",
  in_progress: "[>]",
  done: "[x]",
};

export function createTodoTool(): AssistantTool {
  return {
    schema: {
      name: "todo",
      description:
        "Replace the task's todo list, its plan: every step in order, each pending, in_progress or done. Each call sends the whole list.",
      properties: {
        items: {
          type: "array",
          description: "The whole list, which replaces the one before",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The step, in a few words" },
              status: { type: "string", enum: [...TODO_STATUSES] },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["items"],
    },
    replay: "safe",
    snippet: "Keep the task's plan as a todo list",
    guidelines: [
      "For work of several steps, keep a todo list with todo: write it before you start, and update it as each step finishes. The owner sees it as the task's plan.",
    ],
    async execute(args) {
      const problems: string[] = [];
      const items = readItems(args.items, problems);
      if (problems.length > 0) return invalidArguments("todo", problems, args);
      const details: TodoDetails = { items };
      return { content: render(items), details };
    },
  };
}

/** The valid items of `value`, with what is wrong with the others added to `problems`. */
function readItems(value: unknown, problems: string[]): TodoItem[] {
  if (!Array.isArray(value)) {
    problems.push(
      `items: ${value === undefined ? "missing" : `expected array, got ${typeName(value)}`}`,
    );
    return [];
  }
  const items: TodoItem[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      problems.push(`items.${index}: expected object, got ${typeName(item)}`);
      continue;
    }
    const { text, status } = item as Record<string, unknown>;
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (typeof text !== "string") {
      problems.push(
        `items.${index}.text: ${text === undefined ? "missing" : `expected string, got ${typeName(text)}`}`,
      );
    } else if (trimmed === "") {
      problems.push(`items.${index}.text: must not be empty`);
    }
    const known = TODO_STATUSES.includes(status as TodoStatus);
    if (!known) problems.push(`items.${index}.status: must be one of ${TODO_STATUSES.join(", ")}`);
    if (trimmed !== "" && known) items.push({ text: trimmed, status: status as TodoStatus });
  }
  return items;
}

function render(items: readonly TodoItem[]): string {
  if (items.length === 0) return "Todo list cleared";
  const done = items.filter((item) => item.status === "done").length;
  const lines = items.map((item) => `${MARKS[item.status]} ${item.text}`);
  return [`Todo list (${done}/${items.length} done):`, ...lines].join("\n");
}
