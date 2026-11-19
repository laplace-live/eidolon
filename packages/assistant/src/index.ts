// The work a persona's tasks do on the owner's computer: the tools a task runs, what keeps them
// inside its folders, the worker's prompt and the task's files. Only the local app and the CLI
// import it; production never has the assistant.
export { COMPACTION_INSTRUCTIONS, COMPACTION_SYSTEM } from "./compaction.ts";
export { MCP_TOOL_PREFIX } from "./mcp/naming.ts";
export {
  type McpConfig,
  type McpPatchResult,
  type McpProblem,
  type McpSecrets,
  type McpServer,
  type McpServerPatch,
  type McpStanding,
  mcpReferences,
  mcpSecretValue,
  mcpStanding,
  parseMcpConfig,
  patchMcpServer,
  readMcpConfig,
  readMcpSecrets,
} from "./mcp/servers.ts";
export {
  type McpFailure,
  McpSession,
  type McpSessionOptions,
  type McpToolRef,
} from "./mcp/session.ts";
export {
  type McpArgument,
  type McpCallDetails,
  type McpLeftOut,
  mcpArgumentList,
  mcpCallKey,
} from "./mcp/tools.ts";
export {
  type FolderGrant,
  FolderPolicy,
  type FolderPolicyOptions,
  GrantRefused,
  grantRefusal,
} from "./policy.ts";
export {
  buildTaskPrompt,
  type ContextFile,
  loadContextFiles,
  type TaskPromptInput,
  taskDate,
} from "./prompt.ts";
export {
  byName,
  catalogOf,
  type FoundSkill,
  isInside,
  loadSkills,
  MAX_DESCRIPTION_LENGTH,
  MAX_SKILL_BYTES,
  oneLine,
  type RequestedSkill,
  SKILL_FILE,
  type Skill,
  type SkillCatalog,
  type SkillProblem,
  type SkillScan,
  type SkillSource,
  scanSkills,
  skillNames,
  skillSwitchesPath,
  skillsDir,
  validateName,
} from "./skills.ts";
export { createTaskTools, type TaskToolsOptions } from "./task-tools.ts";
export {
  BASH,
  BASH_KILL,
  BASH_OUTPUT,
  type BashOperations,
  bashCommand,
  bashTimeoutSeconds,
  createLocalBashOperations,
  DEFAULT_TIMEOUT_S,
  MAX_BACKGROUND,
  MAX_COMMAND_BYTES,
  MAX_TIMEOUT_S,
} from "./tools/bash.ts";
export type { FindDetails } from "./tools/find.ts";
export type { GrepDetails } from "./tools/grep.ts";
export {
  type BackgroundCommand,
  type BashDetails,
  type BashEnd,
  BashJobs,
  type BashJobsOptions,
  type BashRunOptions,
} from "./tools/jobs.ts";
export type { LsDetails } from "./tools/ls.ts";
export { withFileMutationQueue } from "./tools/mutation-queue.ts";
export { expandPath, pathExists, resolveReadPath, resolveToCwd } from "./tools/path.ts";
export { bashOffered, killProcessTree, shellEnv } from "./tools/shell.ts";
export { createSkillTool, type TaskSkills, taskSkills } from "./tools/skill.ts";
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
  createWebFetchTool,
  WEB_FETCH,
  type WebAccess,
  type WebFetchDetails,
  type WebFetchOptions,
  webFetchHost,
} from "./tools/web-fetch.ts";
export {
  createWebSearchTool,
  WEB_SEARCH,
  type WebSearchDetails,
  type WebSearcher,
  type WebSearchResult,
} from "./tools/web-search.ts";
export {
  isEnded,
  isLive,
  isTaskId,
  newTaskId,
  openTaskStore,
  readSnapshot,
  replaceJsonFile,
  TASK_PROFILES,
  TASK_STATUSES,
  TASK_WEB_MODES,
  type TaskChat,
  type TaskInboxLines,
  type TaskPause,
  type TaskPending,
  type TaskProfile,
  type TaskSnapshot,
  type TaskStatus,
  type TaskWebAccess,
  type TaskWebMode,
  taskLockKey,
  tasksDir,
  transcriptPath,
  writeSnapshot,
} from "./transcript.ts";
export { type AssistantTool, type PathGuard, PathRefused } from "./types.ts";
