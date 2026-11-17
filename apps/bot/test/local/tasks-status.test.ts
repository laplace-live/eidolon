// The 后台的活 block: what it says of each of her tasks in a chat, word for word, that nothing the
// worker wrote ever reaches it, and how its provider places and replaces it in her view.
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { activePersona, withPersona } from "@eidolon/config";
import { TurnConversation } from "../../../../packages/engine/src/context.ts";
import { STEER_PREFIX, type TaskSnapshot } from "../../src/local/api.ts";
import {
  herTasks,
  TASKS_BLOCK_PREFIX,
  tasksBlock,
  tasksStatusProvider,
} from "../../src/local/tasks/status.ts";

const HOME = "/Users/me";
const CHAT = "chat-1";
const PERSONA = "milky-green";
const HEADER =
  "后台的活：\n你在这个聊天里用 start_task 在电脑上做的事，现在是这样（以这里为准，比前面聊天记录里的新）：";
const TOOLS_TAIL =
  "对方问进度就照这里说，要具体的计划、文件或刚才那一步就调用 check_task 看；" +
  "对方要改要求就用 steer_task 转告，明确说不要了才用 stop_task。允许和继续只能对方在任务卡片上点，你替不了。";
const PLAIN_TAIL = "对方问进度就照这里说。允许、继续和停止都只能对方在任务卡片上点，你替不了。";

const BRIEF = {
  goal: "写一个待办网页",
  deliverable: "index.html",
  folder: `${HOME}/site`,
  check: "能添加和删除",
};

let made = 0;

/** A task of hers in CHAT, started in ~/site, running. */
function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  made++;
  return {
    v: 1,
    id: `0190f5c8-0000-7000-8000-${String(made).padStart(12, "0")}`,
    createdAt: 1000 + made,
    status: "running",
    chat: { id: CHAT, persona: PERSONA, call: `call_${made}` },
    brief: BRIEF,
    model: { account: "openrouter", model: "test/model" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
    ...overrides,
  };
}

function block(snapshots: readonly TaskSnapshot[], tools = false): string {
  return tasksBlock(herTasks(snapshots, CHAT, PERSONA), { tools, home: HOME });
}

/** The block of a task alone, which is task 1, started by call `call_1`. */
function only(overrides: Partial<TaskSnapshot>, tools = false): string {
  made = 0;
  return block([task(overrides)], tools);
}

const line = (phrase: string) =>
  `任务1「写一个待办网页」（start_task 调用 call_1，在 ~/site）：${phrase}。`;

describe("the block", () => {
  test("names each status in words of ours", () => {
    const cases: [Partial<TaskSnapshot>, string][] = [
      [
        { status: "awaiting-approval", pending: { kind: "start" } },
        "还没开始，聊天里的任务卡片在等对方点允许，点了才开始",
      ],
      [{ status: "running" }, "正在做"],
      [
        {
          status: "paused",
          pending: { kind: "path", path: "/etc/hosts", access: "read", folder: "/etc" },
          pause: { reason: "approval", detail: "read access to /etc/hosts" },
        },
        "停着，任务卡片在问对方能不能读任务文件夹外面的一个地方，对方答了才接着做",
      ],
      [
        {
          status: "paused",
          pending: { kind: "path", path: "/tmp/x/a.txt", access: "write" },
          pause: { reason: "approval", detail: "write access to /tmp/x/a.txt" },
        },
        "停着，任务卡片在问对方能不能写任务文件夹外面的一个地方，对方答了才接着做",
      ],
      [
        {
          status: "paused",
          pending: { kind: "fetch", host: "react.dev" },
          pause: { reason: "approval", detail: "fetch from react.dev" },
        },
        "停着，任务卡片在问对方能不能上一个网站看看，对方答了才接着做",
      ],
      [
        {
          status: "paused",
          spentUsd: 1.2,
          pause: { reason: "spend", detail: "Spent $1.20; it pauses at every $1.00." },
        },
        "停着，已经花了 $1.20，任务卡片在问对方要不要接着做",
      ],
      [
        { status: "paused", pause: { reason: "stall", detail: "The same calls 3 turns running" } },
        "停着，连着几轮都在做一样的事，像是卡住了，任务卡片在问对方要不要接着做",
      ],
      [
        { status: "paused", pause: { reason: "unpriced", detail: "No price is known" } },
        "停着，这个模型的花费算不出来，任务卡片在问对方要不要不管花费接着做",
      ],
      [{ status: "interrupted" }, "中断了，程序重启时停在半路，对方在任务卡片上点继续就接着做"],
      [
        { status: "succeeded", outcome: { status: "succeeded", report: "Done." } },
        "刚做完，结果会出现在那次调用的返回里",
      ],
      [
        { status: "failed", outcome: { status: "failed", error: "No model" } },
        "刚失败了，原因会出现在那次调用的返回里",
      ],
      [{ status: "cancelled", outcome: { status: "cancelled" } }, "被停掉了"],
    ];
    for (const [overrides, phrase] of cases) {
      expect(only(overrides)).toBe(`${HEADER}\n${line(phrase)}\n${PLAIN_TAIL}`);
    }
  });

  test("a running task's plan, files, latest step and spend, each when there is one", () => {
    const todo = [
      { text: "a", status: "done" },
      { text: "b", status: "done" },
      { text: "c", status: "in_progress" },
      { text: "d", status: "pending" },
      { text: "e", status: "pending" },
    ] as const;
    const files = { read: [], written: ["/Users/me/site/a", "/Users/me/site/b", "/x/c"] };
    expect(only({ todo, files, step: { tool: "write", head: "a" }, spentUsd: 0.123 })).toBe(
      `${HEADER}\n${line("正在做，计划 5 步做完 2 步，写了 3 个文件，刚才在写文件，花了 $0.12")}\n${PLAIN_TAIL}`,
    );
    expect(only({ files, spentUsd: 0.5 })).toContain("：正在做，写了 3 个文件，花了 $0.50。");
    expect(only({ todo })).toContain("：正在做，计划 5 步做完 2 步。");
  });

  test("the latest step's tool in words of ours", () => {
    const actions: Record<string, string> = {
      read: "读文件",
      write: "写文件",
      edit: "改文件",
      ls: "看文件夹",
      find: "找文件",
      grep: "在文件里搜",
      web_fetch: "上网看网页",
      todo: "排计划",
    };
    for (const [tool, action] of Object.entries(actions)) {
      expect(only({ step: { tool, head: "x" } })).toContain(`：正在做，刚才在${action}。`);
    }
  });

  test("how many of her lines a live task hasn't read yet, the owner's answers not counted", () => {
    const inbox = {
      steer: [
        `${STEER_PREFIX}标题写成今天的事`,
        "The owner allowed read access to /Users/me/notes. Try again.",
        `${STEER_PREFIX}用蓝色`,
      ],
      followUp: [],
    };
    expect(only({ inbox })).toContain("：正在做；你转告的话还有 2 句没送到。");
    expect(
      only({
        status: "paused",
        pending: { kind: "fetch", host: "react.dev" },
        inbox: { steer: [`${STEER_PREFIX}x`], followUp: [] },
      }),
    ).toContain("对方答了才接着做；你转告的话还有 1 句没送到。");
    expect(only({ inbox: { steer: ["The owner refused access to /x."], followUp: [] } })).toContain(
      "：正在做。",
    );
  });

  test("its tail names her task tools only when the turn has them", () => {
    expect(only({}, true)).toBe(`${HEADER}\n${line("正在做")}\n${TOOLS_TAIL}`);
    expect(only({}, false)).toBe(`${HEADER}\n${line("正在做")}\n${PLAIN_TAIL}`);
  });

  test("is empty once nothing of hers is live or unreported", () => {
    made = 0;
    const reported = task({
      status: "succeeded",
      outcome: { status: "succeeded", report: "Done." },
      reported: true,
    });
    expect(block([reported])).toBe("");
    expect(block([])).toBe("");
  });

  test("at most five lines, the live first, then a line for the rest", () => {
    made = 0;
    const ended = { outcome: { status: "succeeded", report: "Done." } } as const;
    const tasks = [
      task({ status: "succeeded", ...ended }),
      task({ status: "running" }),
      task({ status: "succeeded", ...ended, reported: true }),
      task({ status: "paused", pause: { reason: "stall", detail: "x" } }),
      task({ status: "failed", outcome: { status: "failed", error: "x" } }),
      task({ status: "awaiting-approval", pending: { kind: "start" } }),
      task({ status: "running" }),
      task({ status: "cancelled", outcome: { status: "cancelled" } }),
    ];
    const lines = block(tasks).split("\n");
    expect(lines.slice(2, -1).map((each) => /^任务(\d+)/.exec(each)?.[1] ?? each)).toEqual([
      "2",
      "4",
      "6",
      "7",
      "8",
      "还有 2 个更早的没列出来。",
    ]);
  });

  test("her goal cut at 30 characters on one line, her folder under home as ~, cut at 60", () => {
    made = 0;
    const goal = "做".repeat(31);
    expect(block([task({ brief: { ...BRIEF, goal } })])).toContain(`任务1「${"做".repeat(30)}…」`);
    made = 0;
    const thirty = `${"做".repeat(29)}页`;
    expect(block([task({ brief: { ...BRIEF, goal: thirty } })])).toContain(`「${thirty}」`);
    made = 0;
    expect(block([task({ brief: { ...BRIEF, goal: "做网页\n  要蓝色" } })])).toContain(
      "「做网页 要蓝色」",
    );
    const folders: [string, string][] = [
      [HOME, "~"],
      [`${HOME}/Desktop/todo`, "~/Desktop/todo"],
      ["/Users/meow/x", "/Users/meow/x"],
      ["/tmp/x", "/tmp/x"],
      [`${HOME}/${"a".repeat(70)}`, `~/${"a".repeat(58)}…`],
    ];
    for (const [folder, shown] of folders) {
      made = 0;
      expect(block([task({ brief: { ...BRIEF, folder } })])).toContain(`，在 ${shown}）`);
    }
  });

  test("numbers her tasks in this chat from 1 by when they started, ended ones counted", () => {
    made = 0;
    const first = task({ status: "succeeded", reported: true });
    const theirs = task({ chat: { id: CHAT, persona: "someone-else", call: "call_x" } });
    const elsewhere = task({ chat: { id: "chat-2", persona: PERSONA, call: "call_y" } });
    const second = task({ createdAt: 5000, id: "0190f5c8-0000-7000-8000-00000000000b" });
    const third = task({ createdAt: 5000, id: "0190f5c8-0000-7000-8000-00000000000c" });
    expect(
      herTasks([third, elsewhere, second, theirs, first], CHAT, PERSONA).map(({ n, snapshot }) => [
        n,
        snapshot.id,
      ]),
    ).toEqual([
      [1, first.id],
      [2, second.id],
      [3, third.id],
    ]);
    const text = block([third, elsewhere, second, theirs, first]);
    expect(text).toContain("任务2「");
    expect(text).toContain("任务3「");
    expect(text).not.toContain("call_x");
    expect(text).not.toContain("call_y");
  });

  test("never carries what the worker wrote", () => {
    const S = "SENTINEL";
    made = 0;
    const worker: Partial<TaskSnapshot> = {
      todo: [
        { text: `${S} plan`, status: "done" },
        { text: `${S} next`, status: "pending" },
      ],
      step: { tool: "write", head: `${S}.html` },
      files: { read: [`/Users/me/site/${S}.md`], written: [`/Users/me/site/${S}.html`] },
      brief: { ...BRIEF, deliverable: `${S} page`, check: `${S} check` },
      inbox: { steer: [`${STEER_PREFIX}${S}`, `The owner allowed ${S}`], followUp: [`${S}`] },
    };
    const snapshots: Partial<TaskSnapshot>[] = [
      { status: "running", spentUsd: 0.3 },
      { status: "awaiting-approval", pending: { kind: "start" } },
      {
        status: "paused",
        pending: { kind: "path", path: `/x/${S}`, access: "write", folder: `/x/${S}-dir` },
        pause: { reason: "approval", detail: `write access to /x/${S}` },
      },
      {
        status: "paused",
        pending: { kind: "fetch", host: `${S}.example.com` },
        pause: { reason: "approval", detail: `fetch from ${S}.example.com` },
      },
      { status: "paused", pause: { reason: "stall", detail: `The same calls: read ${S}` } },
      { status: "paused", pause: { reason: "spend", detail: `Spent ${S}` } },
      { status: "paused", pause: { reason: "unpriced", detail: `${S} has no price` } },
      { status: "interrupted" },
      { status: "succeeded", outcome: { status: "succeeded", report: `${S} done` } },
      { status: "failed", outcome: { status: "failed", error: `${S} failed` } },
      { status: "cancelled", outcome: { status: "cancelled" } },
    ];
    for (const status of snapshots) {
      for (const tools of [true, false]) {
        const text = only({ ...worker, ...status }, tools);
        expect(text).not.toBe("");
        expect(text).not.toContain(S);
      }
    }
  });
});

/** The task manager as the provider reads it. */
function lister(snapshots: readonly TaskSnapshot[]) {
  return {
    list: async (query: { chat?: string } = {}) =>
      snapshots.filter((each) => query.chat === undefined || each.chat?.id === query.chat),
  };
}

/** Runs the provider over `messages`, whose blocks came from the log at `blocks`' seqs. */
async function provide(
  snapshots: readonly TaskSnapshot[],
  messages: readonly unknown[],
  blocks: ReadonlyMap<unknown, number> = new Map(),
  tools = true,
): Promise<TurnConversation> {
  const conversation = new TurnConversation(messages, {
    persona: activePersona().id,
    turn: "turn-1",
    blocks,
  });
  const { provider } = tasksStatusProvider(lister(snapshots), CHAT, { tools });
  await provider.onContext({
    context: conversation,
    metadata: {},
    signal: new AbortController().signal,
    spawn: () => {},
  });
  return conversation;
}

const roles = (conversation: TurnConversation) =>
  conversation.getMessages().map((message) => (message as { role: string }).role);

describe("its provider", () => {
  const user = (content: string) => ({ role: "user", content });
  const her = (content: string) => ({ role: "assistant", content });
  const toolCalls = {
    role: "assistant",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "start_task", arguments: "{}" } },
    ],
  };
  const toolResult = { role: "tool", tool_call_id: "call_1", content: "{}" };

  test("puts it just before the last user message, never between a call and its result", async () => {
    made = 0;
    const running = [task({ chat: { id: CHAT, persona: activePersona().id, call: "call_1" } })];
    const messages = [
      user("帮我写个网页"),
      toolCalls,
      toolResult,
      her("交给我吧"),
      user("弄好了吗？"),
    ];
    const conversation = await provide(running, messages);
    expect(roles(conversation)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "developer",
      "user",
    ]);
    const recorded = conversation.takeRecorded();
    expect(recorded).toEqual([
      {
        type: "context",
        persona: activePersona().id,
        turn: "turn-1",
        position: 4,
        role: "developer",
        content: expect.stringMatching(new RegExp(`^${TASKS_BLOCK_PREFIX}\n`)),
      },
    ]);
    // Her report turn, whose view ends past the line it answered; and a view with no user line.
    const report = await provide(running, [user("帮我写个网页"), toolCalls, toolResult]);
    expect(roles(report)).toEqual(["developer", "user", "assistant", "tool"]);
    const none = await provide(running, [her("嗨")]);
    expect(roles(none)).toEqual(["assistant", "developer"]);
  });

  test("replaces its earlier block: the old one removed, the new one put in", async () => {
    made = 0;
    const persona = activePersona().id;
    const old = { role: "developer", content: `${TASKS_BLOCK_PREFIX}\n任务1……还没开始` };
    const messages = [user("帮我写个网页"), old, user("弄好了吗"), her("还没"), user("现在呢")];
    const running = [task({ chat: { id: CHAT, persona, call: "call_1" } })];
    const conversation = await provide(running, messages, new Map([[old, 7]]));
    expect(roles(conversation)).toEqual(["user", "user", "assistant", "developer", "user"]);
    expect(conversation.takeRecorded()).toEqual([
      { type: "context-removed", persona, turn: "turn-1", seqs: [7] },
      expect.objectContaining({ type: "context", position: 3, role: "developer" }),
    ]);
  });

  test("records nothing when its block is unchanged and in place", async () => {
    made = 0;
    const persona = activePersona().id;
    const running = [task({ chat: { id: CHAT, persona, call: "call_1" } })];
    const text = tasksBlock(herTasks(running, CHAT, persona), { tools: false, home: homedir() });
    // Her report turn on the line her last answer's block sits before.
    const placed = { role: "developer", content: text };
    const messages = [
      user("帮我写个网页"),
      placed,
      user("弄好了吗"),
      her("在做了"),
      toolCalls,
      toolResult,
    ];
    const conversation = await provide(running, messages, new Map([[placed, 9]]), false);
    expect(conversation.takeRecorded()).toEqual([]);
    expect(conversation.getMessages()).toEqual(messages);
    // The same text before a newer line moves, so it is recorded again.
    const later = [...messages, user("还要多久")];
    const moved = await provide(running, later, new Map([[placed, 9]]), false);
    expect(moved.takeRecorded().map((each) => each.type)).toEqual(["context-removed", "context"]);
  });

  test("takes its block out once nothing of hers is listed, and records nothing if there was none", async () => {
    made = 0;
    const persona = activePersona().id;
    const old = { role: "developer", content: `${TASKS_BLOCK_PREFIX}\n任务1……正在做` };
    const reported = task({
      chat: { id: CHAT, persona, call: "call_1" },
      status: "succeeded",
      reported: true,
    });
    const conversation = await provide([reported], [old, user("好了吗")], new Map([[old, 3]]));
    expect(conversation.getMessages()).toEqual([user("好了吗")]);
    expect(conversation.takeRecorded()).toEqual([
      { type: "context-removed", persona, turn: "turn-1", seqs: [3] },
    ]);
    const bare = await provide([reported], [user("好了吗")]);
    expect(bare.takeRecorded()).toEqual([]);
  });

  test("lists the tasks of the persona the turn runs as", async () => {
    made = 0;
    const mine = task({ chat: { id: CHAT, persona: activePersona().id, call: "call_mine" } });
    const theirs = task({ chat: { id: CHAT, persona: "second-persona", call: "call_theirs" } });
    const asOther = await withPersona("second-persona", () =>
      provide([mine, theirs], [user("好了吗")]),
    );
    const [shown] = asOther.getMessages() as { content: string }[];
    expect(shown?.content).toContain("任务1「写一个待办网页」（start_task 调用 call_theirs");
    expect(shown?.content).not.toContain("call_mine");
  });

  test("a failure is the provider's, in its own words", () => {
    const { label, provider } = tasksStatusProvider(lister([]), CHAT, { tools: false });
    expect(label).toBe("TasksStatus");
    expect(provider.errorMessage(new Error("no tasks"))).toBe("Tasks status: no tasks");
  });
});
