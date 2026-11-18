// start_task, her one way to use the owner's computer, the line her persona prefix gives it, and the
// nudges her turns answer about a task. It hands her brief to the task manager and answers at once;
// the task's end reaches the chat later, as her call's `final`.
import { logger } from "@eidolon/config";
import type { BackgroundTool } from "@eidolon/engine";
import type {
  CheckTaskToolName,
  StartTaskFinal,
  StartTaskStarted,
  StartTaskToolName,
  SteerTaskToolName,
  StopTaskToolName,
  TaskProfile,
  TaskSnapshot,
} from "../api.ts";
import { type TaskBriefInput, TaskRefused } from "./manager.ts";

export const START_TASK: StartTaskToolName = "start_task";
export const STEER_TASK: SteerTaskToolName = "steer_task";
export const STOP_TASK: StopTaskToolName = "stop_task";
export const CHECK_TASK: CheckTaskToolName = "check_task";

/**
 * Starts the task her call `callId` asks for: the manager's start, with that call as its origin.
 * `args` are her arguments as she gave them.
 */
export type StartTask = (
  input: TaskBriefInput,
  callId: string,
  args: Readonly<Record<string, unknown>>,
) => Promise<Pick<TaskSnapshot, "id" | "status">>;

/** How much of the worker's last text her call's `final` carries. */
const REPORT_MAX_CHARS = 4000;

/** How many of the files it wrote her call's `final` names: it stays in each later turn's view. */
const FILES_MAX = 50;

/** How each nudge about a task starts, before her call's id: a call's seed drops them by it. */
export const TASK_NUDGE_LEAD = `你用 ${START_TASK} 在电脑上做的事（调用 `;

/** What her tasks can do on this computer beyond files and the web, which her texts tell her. */
export interface TaskAbilities {
  /** Run commands, each after the owner's OK on the task's card: the manager's offersCommands. */
  readonly commands: boolean;
}

/** The kinds of task she may name; each but `other` may have an account and model of its own. */
const PROFILES = ["quick", "coding", "research", "other"] as const;

function startTaskSchema({ commands }: TaskAbilities): BackgroundTool["schema"] {
  const what = commands
    ? "在这台电脑上动手做一件事：写代码、做网页、写或修改文件、在文件夹里找东西、上网看网页查资料，" +
      "还能运行命令和程序，比如跑测试、装依赖、用 git、删除或移动文件；" +
      "每条命令都要对方在聊天里的任务卡片上点允许才会运行（对方选过始终允许的除外）。" +
      "对方要你在电脑上做这些时调用。打开文件、网页或软件给对方看，看图片，" +
      "这些都做不到，别调用，直接跟对方说现在还做不到。"
    : "在这台电脑上动手做一件事：写代码、做网页、写或修改文件、在文件夹里找东西、上网看网页查资料。" +
      "对方要你在电脑上做这些时调用。打开文件、网页或软件给对方看，运行程序或命令，" +
      "删除、移动或重命名文件，看图片，这些都做不到，别调用，直接跟对方说现在还做不到。";
  return {
    name: START_TASK,
    description:
      `${what}调用后马上返回：status 是 running 就是开始做了，awaiting-approval ` +
      "是要等对方在聊天里的任务卡片上点允许才开始。活在后台做，做完结果会自己回来。" +
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
      profile: {
        type: "string",
        enum: [...PROFILES],
        description:
          "这是哪一类活：coding 是写代码、做网页或小程序、改代码；research 是上网查资料、比较、整理成报告；" +
          "quick 是几分钟就能做完的小活，比如写个清单、改几处文字、在文件夹里找东西；" +
          "三类都不像就选 other。拿不准就选最接近的",
      },
    },
    required: ["goal", "folder", "profile"],
  };
}

/**
 * Her `profile` as a kind of task with a model of its own; none for `other`. One that is missing or
 * no kind starts the task anyway, on Assistant Mode's own model: her chat tools aren't checked
 * against their schema, and starting the task matters more than where it runs.
 */
function profileOf(given: unknown): TaskProfile | undefined {
  const value = typeof given === "string" ? given.trim().toLowerCase() : given;
  if (value === "other") return undefined;
  const kind = PROFILES.find((each) => each === value);
  if (kind !== undefined) return kind as TaskProfile;
  logger.warning(
    given === undefined || given === null
      ? "start_task came without a profile: the task runs on Assistant Mode's own model"
      : `start_task's profile ${JSON.stringify(given)} is no kind of task: it runs on Assistant Mode's own model`,
  );
  return undefined;
}

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
  const profile = profileOf(args.profile);
  return { goal, folder, ...optional, ...(profile === undefined ? {} : { profile }) };
}

/**
 * start_task over `start`, its description naming what her tasks can do. A refusal the manager
 * explains, a folder it won't grant or one another task works in, is an error result she can tell
 * the owner; her turn's interruption never reaches the task.
 */
export function startTaskTool(start: StartTask, abilities: TaskAbilities): BackgroundTool {
  return {
    schema: startTaskSchema(abilities),
    cancelOnInterruption: false,
    timeoutSecs: null,
    async run({ arguments: args, callId }) {
      const brief = briefOf(args);
      if (typeof brief === "string") return { error: brief };
      let task: Pick<TaskSnapshot, "id" | "status">;
      try {
        task = await start(brief, callId, args);
      } catch (error) {
        if (error instanceof TaskRefused) return { error: error.message };
        throw error;
      }
      return startedOf(task);
    },
  };
}

/** start_task's result for the task a start made: stored as her call's `started` result. */
export function startedOf(task: Pick<TaskSnapshot, "id" | "status">): StartTaskStarted {
  return {
    task: task.id,
    status: task.status === "awaiting-approval" ? "awaiting-approval" : "running",
  };
}

/** Her persona-prefix line for start_task, naming what her tasks can do. */
export function assistantPromptHint({ commands }: TaskAbilities): string {
  const what = commands
    ? "你能直接用这台电脑做事：写代码、做网页、写和改文件、上网查资料，" +
      "还能运行命令和程序（跑测试、装依赖、用 git、删除或移动文件），都是你自己动手。" +
      `要用电脑就调用 ${START_TASK} 工具，这是你碰电脑的唯一方式，不要说自己用不了电脑。` +
      "每条命令运行前都要对方在聊天里的任务卡片上点允许（对方选过始终允许的除外）。" +
      "不过现在你还不能打开文件、网页或软件给对方看，也看不了图片，对方要的话就直说，告诉对方文件在哪，"
    : "你能直接用这台电脑做事：写代码、做网页、写和改文件、上网查资料，都是你自己动手。" +
      `要用电脑就调用 ${START_TASK} 工具，这是你碰电脑的唯一方式，不要说自己用不了电脑。` +
      "不过现在你在电脑上只会读写文件、上网看网页：打开文件、网页或软件给对方看，运行程序，" +
      "删除或移动文件，看图片，这些还做不到，对方要的话就直说，告诉对方文件在哪，";
  return (
    `${what}别为这些调用 ${START_TASK}。调用后看返回的 status：running 是已经开始了，说一句交给你了就行；` +
    "awaiting-approval 是还没开始，得对方在聊天里的任务卡片上点了允许才开始，要跟对方说一声。" +
    "交出去的事别再调用一次，做完了结果会自己回来。"
  );
}

/**
 * What her report turn on her call `callId` answers: words of ours alone, since the worker's report,
 * which may quote a page it read, stays in that call's result.
 */
export function taskEndedNudge(callId: string): string {
  return (
    `${TASK_NUDGE_LEAD}${callId}）结束了，结果在那次调用的返回里。` +
    "用一两句话自然地告诉对方：做成了什么，或者卡在了哪儿；内容多就挑要紧的说，细节等对方问。"
  );
}

/**
 * What her reply on a call answers when task `callId` pauses for the owner: a pointer to its card,
 * which alone takes the answer.
 */
export function taskWaitingNudge(callId: string): string {
  return (
    `${TASK_NUDGE_LEAD}${callId}）停下来了，要等对方在聊天里的任务卡片上点一下才会接着做；` +
    "嘴上答应不算，得在卡片上点。用一句话自然地提醒对方去看看卡片。"
  );
}

/**
 * What her reply on a verbose chat's call answers when task `callId`'s plan gets further. A count
 * here would be stale by the time she speaks, and nothing she sees names the step that finished.
 */
export function taskProgressNudge(callId: string): string {
  return (
    `${TASK_NUDGE_LEAD}${callId}）又往前做了一些。照「后台的活」里它那条的计划步数，` +
    "用一句话随口告诉对方现在做完几步了；具体是哪一步你看不到，别猜，也别念路径或文件名。"
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
