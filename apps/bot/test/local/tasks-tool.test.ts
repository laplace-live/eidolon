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
import { captureLogs } from "../fakes.ts";

const effects = {} as Parameters<BackgroundTool["run"]>[1];

const COMMANDS = { commands: true };
const NO_COMMANDS = { commands: false };

const STATUS_TAIL =
  "调用后马上返回：status 是 running 就是开始做了，awaiting-approval " +
  "是要等对方在聊天里的任务卡片上点允许才开始。活在后台做，做完结果会自己回来。" +
  "后台干活时看不到这段聊天，只看得到这几个参数，所以要把要求写完整。";

const HINT_TAIL =
  "别为这些调用 start_task。调用后看返回的 status：running 是已经开始了，说一句交给你了就行；" +
  "awaiting-approval 是还没开始，得对方在聊天里的任务卡片上点了允许才开始，要跟对方说一声。" +
  "交出去的事别再调用一次，做完了结果会自己回来。";

describe("her text for start_task", () => {
  test("the hint keys her line on the status it returns, and says what she can't do yet", () => {
    expect(assistantPromptHint(NO_COMMANDS)).toBe(
      "你能直接用这台电脑做事：写代码、做网页、写和改文件、上网查资料，都是你自己动手。" +
        "要用电脑就调用 start_task 工具，这是你碰电脑的唯一方式，不要说自己用不了电脑。" +
        "不过现在你在电脑上只会读写文件、上网看网页：打开文件、网页或软件给对方看，运行程序，" +
        "删除或移动文件，看图片，这些还做不到，对方要的话就直说，告诉对方文件在哪，" +
        HINT_TAIL,
    );
  });

  test("with commands, the hint says her tasks run them after the owner's OK on the card, Always aside, and still can't open things for the owner", () => {
    expect(assistantPromptHint(COMMANDS)).toBe(
      "你能直接用这台电脑做事：写代码、做网页、写和改文件、上网查资料，" +
        "还能运行命令和程序（跑测试、装依赖、用 git、删除或移动文件），都是你自己动手。" +
        "要用电脑就调用 start_task 工具，这是你碰电脑的唯一方式，不要说自己用不了电脑。" +
        "每条命令运行前都要对方在聊天里的任务卡片上点允许（对方选过始终允许的除外）。" +
        "不过现在你还不能打开文件、网页或软件给对方看，也看不了图片，对方要的话就直说，告诉对方文件在哪，" +
        HINT_TAIL,
    );
  });

  test("its description says what it can't do and what each status means", () => {
    const { schema } = startTaskTool(async () => ({ id: "t", status: "running" }), NO_COMMANDS);
    expect(schema.name).toBe(START_TASK);
    expect(schema.description).toBe(
      "在这台电脑上动手做一件事：写代码、做网页、写或修改文件、在文件夹里找东西、上网看网页查资料。" +
        "对方要你在电脑上做这些时调用。打开文件、网页或软件给对方看，运行程序或命令，" +
        "删除、移动或重命名文件，看图片，这些都做不到，别调用，直接跟对方说现在还做不到。" +
        STATUS_TAIL,
    );
  });

  test("with commands, its description offers them, each after the owner's OK on the card, Always aside", () => {
    const { schema } = startTaskTool(async () => ({ id: "t", status: "running" }), COMMANDS);
    expect(schema.description).toBe(
      "在这台电脑上动手做一件事：写代码、做网页、写或修改文件、在文件夹里找东西、上网看网页查资料，" +
        "还能运行命令和程序，比如跑测试、装依赖、用 git、删除或移动文件；" +
        "每条命令都要对方在聊天里的任务卡片上点允许才会运行（对方选过始终允许的除外）。" +
        "对方要你在电脑上做这些时调用。打开文件、网页或软件给对方看，看图片，" +
        "这些都做不到，别调用，直接跟对方说现在还做不到。" +
        STATUS_TAIL,
    );
  });

  test("she names each task's kind, in words of the work alone: never a model or a cost", () => {
    for (const abilities of [COMMANDS, NO_COMMANDS]) {
      const { schema } = startTaskTool(async () => ({ id: "t", status: "running" }), abilities);
      expect(schema.required).toEqual(["goal", "folder", "profile"]);
      expect(Object.keys(schema.properties)).toEqual([
        "goal",
        "deliverable",
        "folder",
        "check",
        "profile",
      ]);
      expect(schema.properties.profile).toEqual({
        type: "string",
        enum: ["quick", "coding", "research", "other"],
        description:
          "这是哪一类活：coding 是写代码、做网页或小程序、改代码；research 是上网查资料、比较、整理成报告；" +
          "quick 是几分钟就能做完的小活，比如写个清单、改几处文字、在文件夹里找东西；" +
          "三类都不像就选 other。拿不准就选最接近的",
      });
    }
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
    }, COMMANDS);
    const args = {
      goal: "写一个网页",
      folder: "~/site",
      deliverable: null,
      profile: "coding",
      extra: 1,
    };
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
    expect(seen).toEqual([
      [{ goal: "写一个网页", folder: "~/site", profile: "coding" }, "call_1", args],
    ]);
  });

  test("a profile is lowercased; other, one that is no kind, or none starts the task on the default, the last two with a warning", async () => {
    const logs = captureLogs();
    try {
      const profiles: unknown[] = [];
      const tool = startTaskTool(async (input) => {
        profiles.push(input.profile);
        return { id: "t1", status: "running" };
      }, COMMANDS);
      for (const profile of [" Research ", "quick", "other", "OTHER", "编程", 3, null, undefined]) {
        await tool.run(
          {
            arguments: { goal: "写一个网页", folder: "~/site", profile },
            callId: "call_1",
            context: {} as never,
            signal: new AbortController().signal,
          },
          effects,
        );
      }
      expect(profiles).toEqual([
        "research",
        "quick",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(logs.lines()).toEqual([
        `WARNING start_task's profile "编程" is no kind of task: it runs on Assistant Mode's own model`,
        "WARNING start_task's profile 3 is no kind of task: it runs on Assistant Mode's own model",
        "WARNING start_task came without a profile: the task runs on Assistant Mode's own model",
        "WARNING start_task came without a profile: the task runs on Assistant Mode's own model",
      ]);
    } finally {
      logs.restore();
    }
  });

  test("startedOf: what a start returns, from the task as the manager answered it", () => {
    expect(startedOf({ id: "t1", status: "awaiting-approval" })).toEqual({
      task: "t1",
      status: "awaiting-approval",
    });
    expect(startedOf({ id: "t2", status: "running" })).toEqual({ task: "t2", status: "running" });
  });
});
