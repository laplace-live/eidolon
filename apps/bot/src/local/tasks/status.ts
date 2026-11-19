// The 后台的活 block: her tasks in a chat, rebuilt at each of her turns there and set just before the
// line she answers. It holds runtime facts and her own words alone: what the worker wrote may quote
// a page it read, so her view holds it only as tool output (check_task, her start_task's final).
import { homedir } from "node:os";
import { sep } from "node:path";
import { isLive } from "@eidolon/assistant";
import type { ParticipantId } from "@eidolon/chat";
import { activePersona, errorText, isPlainObject, raceAbort } from "@eidolon/config";
import type { PersonaParts } from "@eidolon/engine";
import { STEER_PREFIX, type TaskSnapshot } from "../api.ts";
import type { TaskManager } from "./manager.ts";
import { doneOf } from "./milestones.ts";
import { CHECK_TASK, START_TASK, STEER_TASK, STOP_TASK } from "./tool.ts";

export const TASKS_BLOCK_NAME = "后台的活";
/** How the block starts: its provider, and a call's seed, find it by this. */
export const TASKS_BLOCK_PREFIX = `${TASKS_BLOCK_NAME}：`;

const LINES_MAX = 5;
const GOAL_CHARS = 30;
const FOLDER_CHARS = 60;

/** The worker's tools, as she would say what it was doing. */
const ACTIONS: Readonly<Record<string, string>> = {
  read: "读文件",
  write: "写文件",
  edit: "改文件",
  ls: "看文件夹",
  find: "找文件",
  grep: "在文件里搜",
  bash: "运行命令",
  bash_output: "看命令的输出",
  bash_kill: "停掉命令",
  web_fetch: "上网看网页",
  web_search: "上网搜索",
  todo: "排计划",
};

/** A task of hers and its number in the chat, which her task tools take. */
export interface NumberedTask {
  readonly n: number;
  readonly snapshot: TaskSnapshot;
}

/** Persona `persona`'s tasks in chat `chatId`, ended ones too, numbered from 1 as they started. */
export function herTasks(
  snapshots: readonly TaskSnapshot[],
  chatId: string,
  persona: ParticipantId,
): NumberedTask[] {
  return snapshots
    .filter(({ chat }) => chat?.id === chatId && chat.persona === persona)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((snapshot, at) => ({ n: at + 1, snapshot }));
}

/** Her lines the task's run hasn't read yet; the owner's answers queued beside them don't count. */
export function unreadOf(snapshot: TaskSnapshot): number {
  return snapshot.inbox?.steer.filter((line) => line.startsWith(STEER_PREFIX)).length ?? 0;
}

const usd = (amount: number): string => `$${amount.toFixed(2)}`;

/** `text` cut at `max` characters. */
export function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** `text` on one line, cut at `max` characters. */
function clip(text: string, max: number): string {
  return cut(text.replace(/\s+/g, " ").trim(), max);
}

function homed(folder: string, home: string): string {
  if (folder === home) return "~";
  return folder.startsWith(`${home}${sep}`) ? `~${folder.slice(home.length)}` : folder;
}

function progress({ todo, files, step, background, spentUsd }: TaskSnapshot): string {
  const parts: string[] = [];
  if (todo !== undefined && todo.length > 0) {
    parts.push(`计划 ${todo.length} 步做完 ${doneOf(todo)} 步`);
  }
  if (files.written.length > 0) parts.push(`写了 ${files.written.length} 个文件`);
  if (step !== undefined) {
    parts.push(`刚才在${Object.hasOwn(ACTIONS, step.tool) ? ACTIONS[step.tool] : "用工具"}`);
  }
  if (background !== undefined && background.length > 0) {
    parts.push(`后台有 ${background.length} 条命令在跑`);
  }
  if (spentUsd > 0) parts.push(`花了 ${usd(spentUsd)}`);
  return parts.map((part) => `，${part}`).join("");
}

function pausedPhrase({ pending, pause, spentUsd }: TaskSnapshot): string {
  if (pending?.kind === "path") {
    const access = pending.access === "write" ? "写" : "读";
    return `停着，任务卡片在问对方能不能${access}任务文件夹外面的一个地方，对方答了才接着做`;
  }
  if (pending?.kind === "fetch") {
    return "停着，任务卡片在问对方能不能上一个网站看看，对方答了才接着做";
  }
  if (pending?.kind === "command") {
    return "停着，任务卡片在问对方能不能运行一条命令，对方答了才接着做";
  }
  if (pending?.kind === "mcp") {
    return "停着，任务卡片在问对方能不能用一个外接的工具，对方答了才接着做";
  }
  switch (pause?.reason) {
    case "spend":
      return `停着，已经花了 ${usd(spentUsd)}，任务卡片在问对方要不要接着做`;
    case "stall":
      return "停着，连着几轮都在做一样的事，像是卡住了，任务卡片在问对方要不要接着做";
    case "unpriced":
      return "停着，这个模型的花费算不出来，任务卡片在问对方要不要不管花费接着做";
    default:
      return "停着，任务卡片在问对方要不要接着做";
  }
}

function phrase(snapshot: TaskSnapshot): string {
  switch (snapshot.status) {
    case "awaiting-approval":
      return "还没开始，聊天里的任务卡片在等对方点允许，点了才开始";
    case "running":
      return `正在做${progress(snapshot)}`;
    case "paused":
      return pausedPhrase(snapshot);
    case "interrupted":
      return "中断了，程序重启时停在半路，对方在任务卡片上点继续就接着做";
    case "succeeded":
      return "刚做完，结果会出现在那次调用的返回里";
    case "failed":
      return "刚失败了，原因会出现在那次调用的返回里";
    case "cancelled":
      return "被停掉了";
  }
}

function lineOf({ n, snapshot }: NumberedTask, home: string): string {
  const { brief, chat, status } = snapshot;
  const unread = isLive(status) ? unreadOf(snapshot) : 0;
  const folder = clip(homed(brief.folder, home), FOLDER_CHARS);
  return (
    `任务${n}「${clip(brief.goal, GOAL_CHARS)}」（${START_TASK} 调用 ${chat?.call ?? ""}，在 ${folder}）：` +
    `${phrase(snapshot)}${unread > 0 ? `；你转告的话还有 ${unread} 句没送到` : ""}。`
  );
}

export interface TasksBlockOptions {
  /** The turn offers her steer_task, stop_task and check_task, which the block's last line names. */
  readonly tools: boolean;
  /** Shown as ~ at a folder's start. */
  readonly home: string;
}

/**
 * The block for her numbered `tasks`: each live one, then each ended one not yet reported, at most
 * five, the newest kept; "" when there are none.
 */
export function tasksBlock(tasks: readonly NumberedTask[], options: TasksBlockOptions): string {
  const live = tasks.filter(({ snapshot }) => isLive(snapshot.status));
  const ended = tasks.filter(
    ({ snapshot }) => !isLive(snapshot.status) && snapshot.reported !== true,
  );
  const kept = new Set(
    [...live]
      .reverse()
      .concat([...ended].reverse())
      .slice(0, LINES_MAX),
  );
  if (kept.size === 0) return "";
  const more = live.length + ended.length - kept.size;
  return [
    TASKS_BLOCK_PREFIX,
    `你在这个聊天里用 ${START_TASK} 在电脑上做的事，现在是这样（以这里为准，比前面聊天记录里的新）：`,
    ...[...live, ...ended]
      .filter((each) => kept.has(each))
      .map((each) => lineOf(each, options.home)),
    ...(more > 0 ? [`还有 ${more} 个更早的没列出来。`] : []),
    options.tools
      ? `对方问进度就照这里说，要具体的计划、文件或刚才那一步就调用 ${CHECK_TASK} 看；` +
        `对方要改要求就用 ${STEER_TASK} 转告，明确说不要了才用 ${STOP_TASK}。` +
        "允许和继续只能对方在任务卡片上点，你替不了。"
      : "对方问进度就照这里说。允许、继续和停止都只能对方在任务卡片上点，你替不了。",
  ].join("\n");
}

function isTasksBlock(message: unknown): boolean {
  return (
    isPlainObject(message) &&
    message.role === "developer" &&
    typeof message.content === "string" &&
    message.content.startsWith(TASKS_BLOCK_PREFIX)
  );
}

/**
 * The block's provider for a turn of hers in chat `chatId`, listing the tasks of the persona the
 * turn runs as: it takes out its earlier block, then puts the new one just before the view's last
 * user message (at the end when there is none), unless nothing is listed. `tools`: the turn offers
 * her task tools.
 */
export function tasksStatusProvider(
  tasks: Pick<TaskManager, "list">,
  chatId: string,
  options: { readonly tools: boolean },
): PersonaParts["providers"][number] {
  const home = homedir();
  return {
    label: "TasksStatus",
    provider: {
      async onContext({ context, signal }) {
        const persona = activePersona().id;
        const snapshots = await raceAbort(tasks.list({ chat: chatId }), signal);
        const text = tasksBlock(herTasks(snapshots, chatId, persona), {
          tools: options.tools,
          home,
        });
        const messages = context.getMessages().filter((message) => !isTasksBlock(message));
        if (text !== "") {
          const last = messages.findLastIndex(
            (message) => isPlainObject(message) && message.role === "user",
          );
          messages.splice(last === -1 ? messages.length : last, 0, {
            role: "developer",
            content: text,
          });
        }
        context.setMessages(messages);
      },
      errorMessage: (error) => `Tasks status: ${errorText(error)}`,
    },
  };
}
