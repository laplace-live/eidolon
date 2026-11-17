// start_task, her one way to use the owner's computer, and the line her persona prefix gives it. It
// hands her brief to the task manager and answers at once; the task's end reaches the chat later,
// as her call's `final`.
import type { BackgroundTool } from "@eidolon/engine";
import type { StartTaskFinal, StartTaskStarted, StartTaskToolName, TaskSnapshot } from "../api.ts";
import { type TaskBriefInput, TaskRefused } from "./manager.ts";

export const START_TASK: StartTaskToolName = "start_task";

/** Starts the task her call `callId` asks for: the manager's start, with that call as its origin. */
export type StartTask = (
  input: TaskBriefInput,
  callId: string,
) => Promise<Pick<TaskSnapshot, "id" | "status">>;

/** How much of the worker's last text her call's `final` carries. */
const REPORT_MAX_CHARS = 4000;

/** How many of the files it wrote her call's `final` names: it stays in each later turn's view. */
const FILES_MAX = 50;

const START_TASK_SCHEMA: BackgroundTool["schema"] = {
  name: START_TASK,
  description:
    "在这台电脑上动手做一件事：写代码、做网页、整理或修改文件、上网查资料。" +
    "对方要你在电脑上做事时调用。调用后马上返回，活在后台做，做完结果会自己回来。" +
    "后台干活时看不到这段聊天，只看得到这几个参数，所以要把要求写完整。",
  properties: {
    goal: {
      type: "string",
      description: "要做成什么，写完整：对方说过的要求、内容和细节都写进去",
    },
    deliverable: {
      type: "string",
      description: "交付什么，例如『一个单文件 index.html』；不填就是 goal",
    },
    folder: {
      type: "string",
      description:
        "在哪个文件夹里做：绝对路径或 ~ 开头，例如 ~/Desktop/todo。" +
        "要写或改的文件都得在里面；对方没说就新起一个",
    },
    check: {
      type: "string",
      description:
        "做完怎么检查，例如『在浏览器打开，能添加、勾选和删除待办』；不填就对照 goal 检查",
    },
  },
  required: ["goal", "folder"],
};

/** Her arguments as the manager takes them, or why they can't be; null stands for an absent field. */
function briefOf(args: Readonly<Record<string, unknown>>): TaskBriefInput | string {
  const { goal, deliverable, folder, check } = args;
  if (typeof goal !== "string" || typeof folder !== "string") {
    return "start_task needs a goal and a folder, as text";
  }
  const optional: Record<string, string> = {};
  for (const [name, value] of Object.entries({ deliverable, check })) {
    if (typeof value === "string") optional[name] = value;
    else if (value !== undefined && value !== null) return `start_task's ${name} is text`;
  }
  return { goal, folder, ...optional };
}

/**
 * start_task over `start`. A refusal the manager explains, a folder it won't grant or one another
 * task works in, is an error result she can tell the owner; her turn's interruption never reaches
 * the task.
 */
export function startTaskTool(start: StartTask): BackgroundTool {
  return {
    schema: START_TASK_SCHEMA,
    cancelOnInterruption: false,
    timeoutSecs: null,
    async run({ arguments: args, callId }) {
      const brief = briefOf(args);
      if (typeof brief === "string") return { error: brief };
      let task: Pick<TaskSnapshot, "id" | "status">;
      try {
        task = await start(brief, callId);
      } catch (error) {
        if (error instanceof TaskRefused) return { error: error.message };
        throw error;
      }
      const started: StartTaskStarted = {
        task: task.id,
        status: task.status === "awaiting-approval" ? "awaiting-approval" : "running",
      };
      return started;
    },
  };
}

/** Her persona-prefix line for start_task. */
export function assistantPromptHint(): string {
  return (
    "你能直接用这台电脑做事：写代码、做网页、整理文件、上网查资料，都是你自己动手。" +
    `要用电脑就调用 ${START_TASK} 工具，这是你碰电脑的唯一方式，不要说自己用不了电脑。` +
    "调用后说一句交给你了就行；聊天里的任务卡片要是在问要不要开始，得对方点了允许才会开始，" +
    "顺口提醒对方一声。做完了结果会自己回来。"
  );
}

/**
 * What her report turn on her call `callId` answers: words of ours alone, since the worker's report,
 * which may quote a page it read, stays in that call's result.
 */
export function taskEndedNudge(callId: string): string {
  return (
    `你用 ${START_TASK} 在电脑上做的事（调用 ${callId}）结束了，结果在那次调用的返回里。` +
    "用一两句话自然地告诉对方：做成了什么，或者卡在了哪儿；内容多就挑要紧的说，细节等对方问。"
  );
}

/** `text`, cut at REPORT_MAX_CHARS characters with a note. */
function cut(text: string): string {
  const chars = [...text];
  if (chars.length <= REPORT_MAX_CHARS) return text;
  const omitted = chars.length - REPORT_MAX_CHARS;
  return `${chars.slice(0, REPORT_MAX_CHARS).join("")}\n\n[... ${omitted} more characters truncated]`;
}

/**
 * Her call's `final` for a task that ended: the runtime's outcome, the worker's report or why it
 * failed, and the first files its tool log shows it wrote. Null while it is live.
 */
export function taskFinal(snapshot: TaskSnapshot): StartTaskFinal | null {
  const { status, outcome } = snapshot;
  if (status !== "succeeded" && status !== "failed" && status !== "cancelled") return null;
  let report = "";
  if (outcome?.status === "succeeded") report = outcome.report;
  else if (outcome?.status === "failed") report = outcome.error;
  const { written } = snapshot.files;
  return {
    status,
    report: cut(report),
    files: written.slice(0, FILES_MAX),
    ...(written.length > FILES_MAX ? { moreFiles: written.length - FILES_MAX } : {}),
    spentUsd: snapshot.spentUsd,
  };
}
