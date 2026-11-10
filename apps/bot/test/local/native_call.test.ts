// A local call inside a chat on the native voice engine: the runner's ChatCall, unchanged, run on
// the native loop over a fake transport, recognizer and voice, with her turns scripted. She opens
// on her view of the chat, and the runner stores each line and photo between the call's ends.
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
import { ChatRunner, type ChatTurn } from "../../src/local/chats/runner.ts";
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

test("the runner stores each line and photo of the call, between its ends", async () => {
  const runner = new ChatRunner({ root: ROOT(), turn: greets });
  const id = await runner.create([PERSONA]);
  await runner.live(id)?.ended;
  const call = await runner.startCall(id, PERSONA);

  const transport = new FakeTransport();
  const speech = new FakeSpeech();
  const turns: FakeTurn[] = [];
  const deps = {
    engine: {},
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
    for (let pulled = 0; pulled < 480; pulled += 240) transport.source?.pull(240);
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
  const brief = (event: ChatEvent) => {
    if (event.type === "message") {
      return [event.speaker.kind, event.text, event.modality ?? "text", event.attachments ?? null];
    }
    if (event.type === "call-started") return ["call-started", event.persona];
    if (event.type === "call-ended") return ["call-ended", event.reason];
    return [event.type];
  };
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
