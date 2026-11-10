// A production call inside a chat on the native voice engine: bindChatCall's binding, unchanged,
// run on the native loop over a fake transport, recognizer and voice, with her turns scripted. She
// opens on the window, and each line and photo reaches the browser through the call, numbered on
// from the window and signed, as on pipedog.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ANONYMOUS, chatPersonas, type JsonObject } from "@eidolon/access";
import { CHAT_FORMAT, type ChatEvent, type ChatEventOf, type ChatHeader } from "@eidolon/chat";
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
import { bindChatCall, CHAT_LINE_MESSAGE } from "../../src/chat/call.ts";
import { ChatFiles } from "../../src/chat/files.ts";
import { ChatSigner, MIN_CHAT_SECRET_LENGTH } from "../../src/chat/sig.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { MILKY } from "./harness.ts";

const CHAT = "0190f5c8-0000-7000-8000-0000000000ee";
const HEADER: ChatHeader = {
  format: CHAT_FORMAT,
  id: CHAT,
  createdAt: 1000,
  participants: [MILKY],
};

let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("each line and photo reaches the browser through the call, numbered on from the window and signed", async () => {
  const signer = await ChatSigner.create("s".repeat(MIN_CHAT_SECRET_LENGTH));
  const files = new ChatFiles();
  const window = {
    header: HEADER,
    events: [
      { seq: 1, at: 1001, type: "message", id: "u1", speaker: { kind: "user" }, text: "在吗" },
    ],
  };
  const requestData: JsonObject = { chat: window, persona: MILKY };
  const bound = await bindChatCall(
    {
      allowed: true,
      user: ANONYMOUS,
      token: null,
      body: { sdp: "v=0\r\n", type: "offer", requestData },
      requestData,
      opusBitrateBps: 96000,
      clientIp: "203.0.113.7",
      quota: { allowed: true, remaining: 4, retryAfterSeconds: 0 },
    },
    { signer, files, personas: chatPersonas },
  );
  if (bound === null || bound instanceof Response) throw new Error("the call wasn't bound");

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

  const done = runNativeSafely(transport, bound.admission, deps, bound.binding);
  await until(() => transport.connected);
  transport.rtvi("client-ready", { version: "2.3.0" });
  await until(() => turns.length === 1);
  const [greeting] = turns as [FakeTurn];
  expect(greeting.request.persona).toBe(MILKY);
  expect(greeting.request.chat.events.map((e) => (e.type === "message" ? e.text : e.type))).toEqual(
    ["在吗"],
  );
  await speaks(greeting, "喂？是你呀");
  transport.rtvi("send-text", { content: "拍一张看看", options: { run_immediately: true } });
  await until(() => turns.length === 2);
  const shot = turns[1] as FakeTurn;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
  const url = selfieStore.publish({ data: png, mediaType: "image/png" }, 600);
  await shot.request.effects.sendServerMessage({ type: "selfie", urls: [url] });
  await speaks(shot, "拍好啦");
  const lines = () =>
    transport.sent.flatMap((m) => {
      const data = m.data as { type?: unknown; event?: ChatEvent } | undefined;
      return m.type === "server-message" && data?.type === CHAT_LINE_MESSAGE && data.event
        ? [data.event as ChatEventOf<"message">]
        : [];
    });
  await until(() => lines().length === 4);
  transport.leave();
  await done;

  const name = `${createHash("sha256").update(png).digest("hex")}.png`;
  expect(
    lines().map(({ seq, speaker, text, modality, attachments, sig }) => ({
      seq,
      speaker: speaker.kind,
      text,
      modality,
      attachments,
      signed: sig !== undefined,
    })),
  ).toEqual([
    {
      seq: 2,
      speaker: "persona",
      text: "喂？是你呀",
      modality: "call",
      attachments: undefined,
      signed: true,
    },
    {
      seq: 3,
      speaker: "user",
      text: "拍一张看看",
      modality: "call",
      attachments: undefined,
      signed: false,
    },
    {
      seq: 4,
      speaker: "persona",
      text: "",
      modality: "call",
      attachments: [{ kind: "image", name, mime: "image/png" }],
      signed: true,
    },
    {
      seq: 5,
      speaker: "persona",
      text: "拍好啦",
      modality: "call",
      attachments: undefined,
      signed: true,
    },
  ]);
  for (const line of lines().filter((l) => l.sig !== undefined)) {
    expect(await signer.verify(CHAT, JSON.parse(JSON.stringify(line)))).toBe(true);
  }
  expect(files.lookup(name)).toMatchObject({ bytes: png, mime: "image/png" });
  // The selfie's own server message still reaches the browser, as on any call.
  expect(transport.sent).toContainEqual({
    label: "rtvi-ai",
    type: "server-message",
    data: { type: "selfie", urls: [url] },
  });
  expect(logs.lines()).toContain(`INFO [chat] Call to 'milky-green' in chat ${CHAT}: hangup`);
  expect(
    logs.lines().filter((line) => line.startsWith("ERROR") || line.startsWith("WARNING")),
  ).toEqual([]);
}, 20_000);
