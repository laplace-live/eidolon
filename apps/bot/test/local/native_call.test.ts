// A local call inside a chat: the runner's ChatCall run on the voice loop over a fake transport,
// recognizer and voice, with her turns scripted. She opens on her view of the chat, and the runner
// stores each line and photo between the call's ends; in a chat of hers alone, her start_task on
// the call too, and a task's end reaches her there, told there only by a line after a reply of hers
// recorded its nudge, else in text after the call; in a verbose chat, so does its plan's progress.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type ChatEvent, viewOf } from "@eidolon/chat";
import { dataHome } from "@eidolon/config";
import type { CallTurnRequest } from "@eidolon/engine";
import { selfieStore } from "@eidolon/imagegen";
import { runNativeSafely } from "../../../../packages/runtime/src/native/engine.ts";
import { BOT_ABOUT } from "../../../../packages/runtime/src/rtvi.ts";
import {
  FakeSpeech,
  FakeStt,
  FakeTransport,
  FakeTurn,
  settle,
} from "../../../../packages/voice/test/call/harness.ts";
import { FakeClock } from "../../../../packages/voice/test/input/clock.ts";
import { SILERO_MODEL, SMART_TURN_MODEL } from "../../../../packages/voice/test/input/speech.ts";
import type { TaskChat, TaskSnapshot } from "../../src/local/api.ts";
import { ChatRunner, type ChatRunnerOptions, type ChatTurn } from "../../src/local/chats/runner.ts";
import { START_TASK, taskEndedNudge, taskProgressNudge } from "../../src/local/tasks/tool.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";

const PERSONA = "milky-green";
const ROOT = () => join(dataHome(), "native-call-chats");

let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
  rmSync(ROOT(), { recursive: true, force: true });
});

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Her greeting as the chat opens: one line. */
const greets: ChatTurn = (request) =>
  (async function* () {
    const turn = "greeting";
    yield { type: "started", turn, persona: request.persona } as const;
    yield {
      type: "events",
      events: [
        {
          type: "message",
          id: "g1",
          speaker: { kind: "persona", id: request.persona },
          text: "你好",
        },
      ],
    } as const;
    yield { type: "ended", turn } as const;
  })();

/** Each event as a short line: what it is, and what tells it apart from its kind. */
const brief = (event: ChatEvent) => {
  if (event.type === "message") {
    return [event.speaker.kind, event.text, event.modality ?? "text", event.attachments ?? null];
  }
  if (event.type === "call-started") return ["call-started", event.persona];
  if (event.type === "call-ended") return ["call-ended", event.reason];
  if (event.type === "tool-call") return ["tool-call", event.name];
  if (event.type === "tool-result") return ["tool-result", event.stage ?? null];
  return [event.type];
};

/** A call with her in chat `id` on the voice loop, answered and ready, her turns scripted. */
async function onCall(runner: ChatRunner, id: string) {
  const call = await runner.startCall(id, PERSONA);
  const transport = new FakeTransport();
  const speech = new FakeSpeech();
  const turns: FakeTurn[] = [];
  const deps = {
    // The call makes her mind before it connects; the fake turns below answer for it.
    engine: { createMind: () => ({ async *stream() {} }) },
    runTurn: (request: CallTurnRequest) => {
      const turn = new FakeTurn(request, `turn-${turns.length + 1}`);
      turns.push(turn);
      return turn.lines;
    },
    openStt: async () => new FakeStt(),
    openSpeech: () => speech,
    openRealtime: () => Promise.reject(new Error("no realtime here")),
    models: { silero: SILERO_MODEL, smartTurn: SMART_TURN_MODEL },
    about: BOT_ABOUT,
    clock: new FakeClock(0),
  } as unknown as Parameters<typeof runNativeSafely>[2];
  /** Plays `samples` of her audio, in the transport's 10 ms frames. */
  const pull = (samples: number) => {
    for (let pulled = 0; pulled < samples; pulled += 240) transport.source?.pull(240);
  };
  /** Her turn's `text`, voiced and played whole. */
  const speaks = async (turn: FakeTurn, text: string) => {
    const before = speech.utterances.length;
    turn.round(text);
    await settle();
    const ending = turn.end();
    await until(
      () => speech.utterances.length > before && speech.utterances.at(-1)?.ended === true,
    );
    const utterance = speech.utterances.at(-1);
    utterance?.pcm(1, 480);
    utterance?.segEnd(1);
    utterance?.finish();
    await settle();
    pull(480);
    await ending;
  };
  const admission = {
    user: { mid: null, uname: null, face: null, isLoggedIn: false },
    token: null,
    requestData: { chatId: id, persona: PERSONA },
  };
  const done = runNativeSafely(transport, admission, deps, call);
  await until(() => transport.connected);
  transport.rtvi("client-ready", { version: "2.3.0" });
  await until(() => turns.length === 1);
  return { call, transport, turns, speech, speaks, pull, done };
}

/** `turn` records its nudge as her context block, as the engine does before her mind runs. */
function recordsNudge(turn: FakeTurn): void {
  const { nudge } = turn.request;
  if (nudge === undefined) throw new Error(`${turn.id} answers no nudge`);
  const context = { persona: PERSONA, turn: turn.id, position: 0, role: "developer" } as const;
  turn.events({ type: "context", ...context, content: nudge });
}

test("the runner stores each line and photo of the call, between its ends", async () => {
  const runner = new ChatRunner({ root: ROOT(), turn: greets });
  const id = await runner.create([PERSONA]);
  await runner.live(id)?.ended;
  const { call, transport, turns, speaks, done } = await onCall(runner, id);
  const [greeting] = turns as [FakeTurn];
  // She opens on her view of the chat.
  const { header, events } = greeting.request.chat;
  expect(viewOf(header, events, PERSONA, { windowMessages: 60, nameOf: (p) => p })).toEqual([
    ...call.seedMessages,
  ]);
  expect(call.seedMessages).toEqual([{ role: "assistant", content: "你好" }]);
  await speaks(greeting, "又见面了");
  transport.rtvi("send-text", { content: "拍一张看看", options: { run_immediately: true } });
  await until(() => turns.length === 2);
  const shot = turns[1] as FakeTurn;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 11]);
  const url = selfieStore.publish({ data: png, mediaType: "image/png" }, 600);
  await shot.request.effects.sendServerMessage({ type: "selfie", urls: [url] });
  await speaks(shot, "拍好啦");
  transport.leave();
  await done;
  await until(() => runner.callIn(id) === null);
  await runner.shutdown();

  const stored = (await runner.store.read(id)).events;
  const name = `${createHash("sha256").update(png).digest("hex")}.png`;
  expect(stored.map(brief)).toEqual([
    ["persona", "你好", "text", null],
    ["call-started", PERSONA],
    ["persona", "又见面了", "call", null],
    ["user", "拍一张看看", "call", null],
    ["persona", "", "call", [{ kind: "image", name, mime: "image/png" }]],
    ["persona", "拍好啦", "call", null],
    ["call-ended", "hangup"],
  ]);
  expect(
    logs.lines().filter((line) => line.startsWith("ERROR") || line.startsWith("WARNING")),
  ).toEqual([]);
}, 20_000);

test("her answer on the call may start a task, which the chat stores, and she tells its end there", async () => {
  const waiting: TaskSnapshot = {
    v: 1,
    id: "0190f5c8-0000-7000-8000-00000000a001",
    createdAt: 1000,
    status: "awaiting-approval",
    pending: { kind: "start" },
    brief: {
      goal: "写一个待办网页",
      deliverable: "写一个待办网页",
      folder: "/site",
      check: "Check it",
    },
    model: { account: "openrouter", model: "test/model" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
  };
  const origins: TaskChat[] = [];
  const tasks: NonNullable<ChatRunnerOptions["tasks"]> = {
    ready: () => true,
    start: async (_input, origin) => {
      origins.push(origin);
      return waiting;
    },
    cancelChat: async () => {},
    list: async () => [],
    snapshotsOf: () => [],
    steer: async () => waiting,
    cancel: async () => waiting,
  };
  let told = 0;
  const runner = new ChatRunner({
    root: ROOT(),
    turn: (request, save) => {
      told++;
      return greets(request, save);
    },
    tasks,
  });
  const id = await runner.create([PERSONA]);
  await runner.live(id)?.ended;
  const { transport, turns, speaks, done } = await onCall(runner, id);
  const [greeting] = turns as [FakeTurn];
  // Every reply gets the status block; only one that answers her caller, start_task.
  expect(greeting.request.providers?.map((entry) => entry.label)).toEqual(["TasksStatus"]);
  expect(greeting.request.background).toBeUndefined();
  await speaks(greeting, "又见面了");
  transport.rtvi("send-text", { content: "帮我写个网页", options: { run_immediately: true } });
  await until(() => turns.length === 2);
  const answer = turns[1] as FakeTurn;
  const start = answer.request.background?.tools[0];
  expect(start?.schema.name).toBe(START_TASK);
  // Her start_task, as the engine runs it: the call's log keeps her call and what it started.
  const args = { goal: "写一个待办网页", folder: "~/site" };
  const call = { persona: PERSONA, turn: answer.id, callId: "call-1" };
  answer.events({ type: "tool-call", ...call, name: START_TASK, arguments: args });
  const context = { getMessages: () => [], setMessages: () => {}, setHiddenTools: () => {} };
  const signal = new AbortController().signal;
  const result = await start?.run(
    { arguments: args, context, signal, callId: "call-1" },
    answer.request.effects,
  );
  expect(result).toEqual({ task: waiting.id, status: "awaiting-approval" });
  answer.events({ type: "tool-result", ...call, result: result ?? {}, stage: "started" });
  await speaks(answer, "交给我吧，你点一下允许");
  // The task ends while she is on the call: she tells it there, in a reply of its own.
  await runner.report({
    ...waiting,
    status: "succeeded",
    outcome: { status: "succeeded", report: "Done." },
    chat: { id, persona: PERSONA, call: "call-1" },
    endedAt: 5000,
  });
  await until(() => turns.length === 3);
  const tells = turns[2] as FakeTurn;
  expect(tells.request.nudge).toBe(taskEndedNudge("call-1"));
  expect(tells.request.background).toBeUndefined();
  expect(
    tells.request.chat.events.flatMap((event) =>
      event.type === "tool-result" ? [[event.callId, event.stage]] : [],
    ),
  ).toEqual([
    ["call-1", "started"],
    ["call-1", "final"],
  ]);
  recordsNudge(tells);
  await speaks(tells, "网页做好啦");
  transport.leave();
  await done;
  await until(() => runner.callIn(id) === null);
  await Bun.sleep(50);
  await runner.shutdown();

  // She told it on the call: no turn of hers after it, and the call's end says so.
  expect(told).toBe(1);
  expect((await runner.store.read(id)).events.at(-1)).toMatchObject({
    type: "call-ended",
    told: ["call-1"],
  });
  expect(origins).toEqual([{ id, persona: PERSONA, call: "call-1" }]);
  const stored = (await runner.store.read(id)).events;
  expect(stored.map(brief)).toEqual([
    ["persona", "你好", "text", null],
    ["call-started", PERSONA],
    ["persona", "又见面了", "call", null],
    ["user", "帮我写个网页", "call", null],
    ["tool-call", START_TASK],
    ["tool-result", "started"],
    ["persona", "交给我吧，你点一下允许", "call", null],
    ["tool-result", "final"],
    ["persona", "网页做好啦", "call", null],
    ["call-ended", "hangup"],
  ]);
  expect(
    logs.lines().filter((line) => line.startsWith("ERROR") || line.startsWith("WARNING")),
  ).toEqual([]);
}, 20_000);

test("in a verbose chat, a step of her task's plan done is told in a follow-up offered no task tools, which tells no end", async () => {
  const running: TaskSnapshot = {
    v: 1,
    id: "0190f5c8-0000-7000-8000-00000000a001",
    createdAt: 1000,
    status: "running",
    brief: { goal: "写一个待办网页", deliverable: "写一个待办网页", folder: "/site", check: "c" },
    model: { account: "openrouter", model: "test/model" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
  };
  let snapshots: TaskSnapshot[] = [];
  const tasks: NonNullable<ChatRunnerOptions["tasks"]> = {
    ready: () => true,
    start: async () => running,
    cancelChat: async () => {},
    list: async () => snapshots,
    snapshotsOf: () => snapshots,
    steer: async () => running,
    cancel: async () => running,
  };
  let told = 0;
  const runner = new ChatRunner({
    root: ROOT(),
    turn: (request, save) => {
      told++;
      return greets(request, save);
    },
    tasks,
  });
  const id = await runner.create([PERSONA]);
  await runner.live(id)?.ended;
  await runner.changeSettings(id, { display: "verbose" });
  const { transport, turns, speaks, done } = await onCall(runner, id);
  await speaks(turns[0] as FakeTurn, "又见面了");
  transport.rtvi("send-text", { content: "帮我写个网页", options: { run_immediately: true } });
  await until(() => turns.length === 2);
  const answer = turns[1] as FakeTurn;
  const start = answer.request.background?.tools[0];
  const args = { goal: "写一个待办网页", folder: "~/site" };
  const ids = { persona: PERSONA, turn: answer.id, callId: "call-1" };
  answer.events({ type: "tool-call", ...ids, name: START_TASK, arguments: args });
  const context = { getMessages: () => [], setMessages: () => {}, setHiddenTools: () => {} };
  const result = await start?.run(
    { arguments: args, context, signal: new AbortController().signal, callId: "call-1" },
    answer.request.effects,
  );
  answer.events({ type: "tool-result", ...ids, result: result ?? {}, stage: "started" });
  await speaks(answer, "交给我吧");
  // The first step of its plan is done.
  const furthered: TaskSnapshot = {
    ...running,
    chat: { id, persona: PERSONA, call: "call-1" },
    todo: [
      { text: "写页面", status: "done" },
      { text: "检查", status: "in_progress" },
    ],
  };
  snapshots = [furthered];
  runner.taskProgress(furthered);
  await until(() => turns.length === 3);
  const tells = turns[2] as FakeTurn;
  expect(tells.request.nudge).toBe(taskProgressNudge("call-1"));
  expect(tells.request.background).toBeUndefined();
  expect(tells.request.tools).toBeUndefined();
  expect(tells.request.providers?.map((entry) => entry.label)).toEqual(["TasksStatus"]);
  recordsNudge(tells);
  await speaks(tells, "做完一步啦，还在弄");
  transport.leave();
  await done;
  await until(() => runner.callIn(id) === null);
  await Bun.sleep(50);
  await runner.shutdown();

  expect(told).toBe(1);
  const stored = (await runner.store.read(id)).events;
  expect(stored.map(brief)).toEqual([
    ["persona", "你好", "text", null],
    ["settings"],
    ["call-started", PERSONA],
    ["persona", "又见面了", "call", null],
    ["user", "帮我写个网页", "call", null],
    ["tool-call", START_TASK],
    ["tool-result", "started"],
    ["persona", "交给我吧", "call", null],
    ["persona", "做完一步啦，还在弄", "call", null],
    ["call-ended", "hangup"],
  ]);
  expect(stored.at(-1)).not.toHaveProperty("told");
  expect(
    logs.lines().filter((line) => line.startsWith("ERROR") || line.startsWith("WARNING")),
  ).toEqual([]);
}, 20_000);

/**
 * A chat of hers alone on a call where her answer started a task, then the owner said goodbye: her
 * reply to that, about something else, is under way. The runner's report turns are counted by the
 * nudge each answers.
 */
async function sayingGoodbye() {
  const running: TaskSnapshot = {
    v: 1,
    id: "0190f5c8-0000-7000-8000-00000000a001",
    createdAt: 1000,
    status: "running",
    brief: { goal: "写一个待办网页", deliverable: "写一个待办网页", folder: "/site", check: "c" },
    model: { account: "openrouter", model: "test/model" },
    grants: [],
    spendPauseUsd: 1,
    spentUsd: 0,
    files: { read: [], written: [] },
  };
  const tasks: NonNullable<ChatRunnerOptions["tasks"]> = {
    ready: () => true,
    start: async () => running,
    cancelChat: async () => {},
    list: async () => [],
    snapshotsOf: () => [],
    steer: async () => running,
    cancel: async () => running,
  };
  const told: (string | undefined)[] = [];
  const runner = new ChatRunner({
    root: ROOT(),
    turn: (request, save) => {
      told.push("nudge" in request ? request.nudge : undefined);
      return greets(request, save);
    },
    tasks,
  });
  const id = await runner.create([PERSONA]);
  await runner.live(id)?.ended;
  const call = await onCall(runner, id);
  const { transport, turns, speaks } = call;
  await speaks(turns[0] as FakeTurn, "又见面了");
  transport.rtvi("send-text", { content: "帮我写个网页", options: { run_immediately: true } });
  await until(() => turns.length === 2);
  const answer = turns[1] as FakeTurn;
  const start = answer.request.background?.tools[0];
  const args = { goal: "写一个待办网页", folder: "~/site" };
  const ids = { persona: PERSONA, turn: answer.id, callId: "call-1" };
  answer.events({ type: "tool-call", ...ids, name: START_TASK, arguments: args });
  const context = { getMessages: () => [], setMessages: () => {}, setHiddenTools: () => {} };
  const result = await start?.run(
    { arguments: args, context, signal: new AbortController().signal, callId: "call-1" },
    answer.request.effects,
  );
  answer.events({ type: "tool-result", ...ids, result: result ?? {}, stage: "started" });
  await speaks(answer, "交给我吧");
  transport.rtvi("send-text", { content: "好，那我先挂了", options: { run_immediately: true } });
  await until(() => turns.length === 3);
  const end: TaskSnapshot = {
    ...running,
    status: "succeeded",
    outcome: { status: "succeeded", report: "Done." },
    chat: { id, persona: PERSONA, call: "call-1" },
    endedAt: 5000,
  };
  return { runner, id, told, ...call, goodbye: turns[2] as FakeTurn, end };
}

test("a reply already under way when her task ends doesn't tell it: cut by a hang-up, she tells it in text after", async () => {
  const { runner, id, told, transport, turns, speech, pull, done, goodbye, end } =
    await sayingGoodbye();
  const before = speech.utterances.length;
  goodbye.round("好呀。拜拜，路上小心。");
  await settle();
  await until(() => speech.utterances.length > before);
  const utterance = speech.utterances.at(-1);
  utterance?.pcm(1, 480);
  utterance?.segEnd(1);
  utterance?.pcm(2, 480);
  await settle();
  pull(720);
  await settle();
  // The task ends while she speaks: the Floor keeps its nudge for a follow-up after her goodbye.
  await runner.report(end);
  await settle();
  expect(turns).toHaveLength(3);
  // The owner hangs up mid-goodbye.
  transport.leave();
  await done;
  await until(() => runner.callIn(id) === null);
  await until(() => told.length === 2);
  await runner.shutdown();
  expect(told).toEqual([undefined, taskEndedNudge("call-1")]);
  const stored = (await runner.store.read(id)).events;
  expect(stored.slice(-4).map(brief)).toEqual([
    ["tool-result", "final"],
    ["persona", "好呀。", "call", null],
    ["call-ended", "hangup"],
    // Her report turn's line, which the fake greeting says.
    ["persona", "你好", "text", null],
  ]);
  expect(stored.find((event) => event.type === "call-ended")).not.toHaveProperty("told");
}, 20_000);

test("her follow-up records the nudge, and the owner hangs up before it says anything: she tells it in text after", async () => {
  const { runner, id, told, transport, turns, speech, pull, done, goodbye, end } =
    await sayingGoodbye();
  const before = speech.utterances.length;
  goodbye.round("好呀。拜拜，路上小心。");
  await settle();
  await until(() => speech.utterances.length > before);
  await runner.report(end);
  await settle();
  // She finishes her goodbye; the follow-up that takes the nudge starts after it.
  const ending = goodbye.end();
  await until(() => speech.utterances.at(-1)?.ended === true);
  const utterance = speech.utterances.at(-1);
  utterance?.pcm(1, 480);
  utterance?.segEnd(1);
  utterance?.pcm(2, 480);
  utterance?.segEnd(2);
  utterance?.finish();
  await settle();
  pull(960);
  await ending;
  await until(() => turns.length === 4);
  const followUp = turns[3] as FakeTurn;
  expect(followUp.request.nudge).toBe(taskEndedNudge("call-1"));
  recordsNudge(followUp);
  await settle();
  // The owner hangs up before it says anything.
  transport.leave();
  await done;
  await until(() => runner.callIn(id) === null);
  await until(() => told.length === 2);
  await runner.shutdown();
  expect(told).toEqual([undefined, taskEndedNudge("call-1")]);
  const stored = (await runner.store.read(id)).events;
  expect(stored.find((event) => event.type === "call-ended")).not.toHaveProperty("told");
}, 20_000);
