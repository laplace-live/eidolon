import { createEditTool } from "./tools/edit.ts";
import { createFindTool } from "./tools/find.ts";
import { createGrepTool } from "./tools/grep.ts";
import { createLsTool } from "./tools/ls.ts";
import { createReadTool } from "./tools/read.ts";
import { createTodoTool } from "./tools/todo.ts";
import { createWebFetchTool, type WebAccess } from "./tools/web-fetch.ts";
import { createWriteTool } from "./tools/write.ts";
import type { AssistantTool, PathGuard } from "./types.ts";

export interface TaskToolsOptions {
  /** The sites web_fetch may reach; without it, the task has no web_fetch. */
  readonly web?: WebAccess;
}

/** A task's tools, in the order its prompt lists them: each file tool inside what `guard` allows. */
export function createTaskTools(guard: PathGuard, options: TaskToolsOptions = {}): AssistantTool[] {
  return [
    createReadTool(guard),
    createWriteTool(guard),
    createEditTool(guard),
    createLsTool(guard),
    createFindTool(guard),
    createGrepTool(guard),
    ...(options.web === undefined ? [] : [createWebFetchTool({ web: options.web })]),
    createTodoTool(),
  ];
}
