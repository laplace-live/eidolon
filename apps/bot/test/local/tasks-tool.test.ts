// start_task's prompt text, the nudges her turns answer, and what start_task hands the manager. The
// Chinese is live prompt text: these hold it word for word.
import { describe, expect, test } from "bun:test";
import type { BackgroundTool } from "@eidolon/engine";
import { TASKS_BLOCK_NAME } from "../../src/local/tasks/status.ts";
import {
  assistantPromptHint,
  START_TASK,
  type StartTask,
  startedOf,
  startTaskTool,
  TASK_NUDGE_LEAD,
  taskEndedNudge,
  taskProgressNudge,
  taskWaitingNudge,
} from "../../src/local/tasks/tool.ts";

const effects = {} as Parameters<BackgroundTool["run"]>[1];

describe("her text for start_task", () => {
  test("the hint keys her line on the status it returns, and says what she can't do yet", () => {
    expect(assistantPromptHint()).toBe(
      "你能直接用这台电脑做事：写代码、做网页、写和改文件、上网查资料，都是你自己动手。" +
        "要用电脑就调用 start_task 工具，这是你碰电脑的唯一方式，不要说自己用不了电脑。" +
        "不过现在你在电脑上只会读写文件、上网看网页：打开文件、网页或软件给对方看，运行程序，" +
        "删除或移动文件，看图片，这些还做不到，对方要的话就直说，告诉对方文件在哪，" +
        "别为这些调用 start_task。调用后看返回的 status：running 是已经开始了，说一句交给你了就行；" +
        "awaiting-approval 是还没开始，得对方在聊天里的任务卡片上点了允许才开始，要跟对方说一声。" +
        "交出去的事别再调用一次，做完了结果会自己回来。",
    );
  });

  test("its description says what it can't do and what each status means", () => {
    const { schema } = startTaskTool(async () => ({ id: "t", status: "running" }));
    expect(schema.name).toBe(START_TASK);
    expect(schema.description).toBe(
      "在这台电脑上动手做一件事：写代码、做网页、写或修改文件、在文件夹里找东西、上网看网页查资料。" +
        "对方要你在电脑上做这些时调用。打开文件、网页或软件给对方看，运行程序或命令，" +
        "删除、移动或重命名文件，看图片，这些都做不到，别调用，直接跟对方说现在还做不到。" +
        "调用后马上返回：status 是 running 就是开始做了，awaiting-approval " +
        "是要等对方在聊天里的任务卡片上点允许才开始。活在后台做，做完结果会自己回来。" +
        "后台干活时看不到这段聊天，只看得到这几个参数，所以要把要求写完整。",
    );
    expect(schema.required).toEqual(["goal", "folder"]);
    expect(Object.keys(schema.properties)).toEqual(["goal", "deliverable", "folder", "check"]);
  });
});

describe("the nudges", () => {
  test("a task's end, unchanged", () => {
    expect(taskEndedNudge("call_7")).toBe(
      "你用 start_task 在电脑上做的事（调用 call_7）结束了，结果在那次调用的返回里。" +
        "用一两句话自然地告诉对方：做成了什么，或者卡在了哪儿；内容多就挑要紧的说，细节等对方问。",
    );
  });

  test("a task's pause, on a call: the card answers it, never her word", () => {
    expect(taskWaitingNudge("call_7")).toBe(
      "你用 start_task 在电脑上做的事（调用 call_7）停下来了，要等对方在聊天里的任务卡片上点一下" +
        "才会接着做；嘴上答应不算，得在卡片上点。用一句话自然地提醒对方去看看卡片。",
    );
  });

  test("her task's plan getting further, on a verbose call: the block's count, never which step", () => {
    expect(taskProgressNudge("call_7")).toBe(
      "你用 start_task 在电脑上做的事（调用 call_7）又往前做了一些。照「后台的活」里它那条的计划步数，" +
        "用一句话随口告诉对方现在做完几步了；具体是哪一步你看不到，别猜，也别念路径或文件名。",
    );
  });

  test("the plan's points her to the block by its name, and only its call varies", () => {
    expect(taskProgressNudge("call_7")).toContain(`「${TASKS_BLOCK_NAME}」`);
    expect(taskProgressNudge("call_7").replace("call_7", "call_8")).toBe(
      taskProgressNudge("call_8"),
    );
  });

  test("all three start with the lead a call's seed drops them by", () => {
    expect(TASK_NUDGE_LEAD).toBe("你用 start_task 在电脑上做的事（调用 ");
    for (const nudge of [taskEndedNudge("x"), taskWaitingNudge("x"), taskProgressNudge("x")]) {
      expect(nudge.startsWith(TASK_NUDGE_LEAD)).toBe(true);
    }
  });
});

describe("start_task", () => {
  test("hands the manager her brief, her call's id and her arguments as she gave them", async () => {
    const seen: Parameters<StartTask>[] = [];
    const tool = startTaskTool(async (...args) => {
      seen.push(args);
      return { id: "t1", status: "awaiting-approval" };
    });
    const args = { goal: "写一个网页", folder: "~/site", deliverable: null, extra: 1 };
    const result = await tool.run(
      {
        arguments: args,
        callId: "call_1",
        context: {} as never,
        signal: new AbortController().signal,
      },
      effects,
    );
    expect(result).toEqual({ task: "t1", status: "awaiting-approval" });
    expect(seen).toEqual([[{ goal: "写一个网页", folder: "~/site" }, "call_1", args]]);
  });

  test("startedOf: what a start returns, from the task as the manager answered it", () => {
    expect(startedOf({ id: "t1", status: "awaiting-approval" })).toEqual({
      task: "t1",
      status: "awaiting-approval",
    });
    expect(startedOf({ id: "t2", status: "running" })).toEqual({ task: "t2", status: "running" });
  });
});
