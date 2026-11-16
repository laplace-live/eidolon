// The work a persona's tasks do on the owner's computer: the tools a task runs, what keeps them
// inside its folders, the worker's prompt and the task's files. Only the local app and the CLI
// import it; production never has the assistant.
export { COMPACTION_INSTRUCTIONS, COMPACTION_SYSTEM } from "./compaction.ts";
export {
  type FolderGrant,
  FolderPolicy,
  type FolderPolicyOptions,
  GrantRefused,
} from "./policy.ts";
export {
  buildTaskPrompt,
  type ContextFile,
  loadContextFiles,
  type TaskPromptInput,
} from "./prompt.ts";
export { createTaskTools } from "./task-tools.ts";
export type { FindDetails } from "./tools/find.ts";
export type { GrepDetails } from "./tools/grep.ts";
export type { LsDetails } from "./tools/ls.ts";
export { withFileMutationQueue } from "./tools/mutation-queue.ts";
export { expandPath, pathExists, resolveReadPath, resolveToCwd } from "./tools/path.ts";
export { TODO_STATUSES, type TodoDetails, type TodoItem, type TodoStatus } from "./tools/todo.ts";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  sliceHead,
  sliceTail,
  type TruncationOptions,
  type TruncationResult,
  truncateHead,
  truncateLine,
  truncateTail,
} from "./tools/truncate.ts";
export {
  newTaskId,
  openTaskStore,
  readSnapshot,
  TASK_STATUSES,
  type TaskSnapshot,
  type TaskStatus,
  tasksDir,
  writeSnapshot,
} from "./transcript.ts";
export { type AssistantTool, type PathGuard, PathRefused } from "./types.ts";
