import type { Skill } from "./skills.ts";
import { createBashTools } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createFindTool } from "./tools/find.ts";
import { createGrepTool } from "./tools/grep.ts";
import type { BashJobs } from "./tools/jobs.ts";
import { createLsTool } from "./tools/ls.ts";
import { createReadTool } from "./tools/read.ts";
import { bashOffered } from "./tools/shell.ts";
import { createSkillTool } from "./tools/skill.ts";
import { createTodoTool } from "./tools/todo.ts";
import { createWebFetchTool, type WebAccess } from "./tools/web-fetch.ts";
import { createWebSearchTool, type WebSearcher } from "./tools/web-search.ts";
import { createWriteTool } from "./tools/write.ts";
import type { AssistantTool, PathGuard } from "./types.ts";

export interface TaskToolsOptions {
  /** The sites web_fetch may reach; without it, the task has no web_fetch and no web_search. */
  readonly web?: WebAccess;
  /** How web_search searches; without it, the task has no web_search. */
  readonly search?: WebSearcher;
  /** The task's commands; without them, or off macOS and Linux, the task has no bash. */
  readonly bash?: BashJobs;
  /** The skills its prompt lists; without any, the task has no skill tool. */
  readonly skills?: readonly Skill[];
}

/** A task's tools, in the order its prompt lists them: each file tool inside what `guard` allows. */
export function createTaskTools(guard: PathGuard, options: TaskToolsOptions = {}): AssistantTool[] {
  const { web, search, bash, skills = [] } = options;
  return [
    createReadTool(guard),
    createWriteTool(guard),
    createEditTool(guard),
    createLsTool(guard),
    createFindTool(guard),
    createGrepTool(guard),
    ...(skills.length === 0 ? [] : [createSkillTool(skills, guard)]),
    ...(bash === undefined || !bashOffered() ? [] : createBashTools(guard, bash)),
    ...(web === undefined ? [] : [createWebFetchTool({ web })]),
    ...(web === undefined || search === undefined ? [] : [createWebSearchTool({ search })]),
    createTodoTool(),
  ];
}
