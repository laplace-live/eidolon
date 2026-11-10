// What the twin scenarios share: the caller's audio, the greeting, and the steps a caller takes.
import { networkInterfaces } from "node:os";
import { concat, noise, syntheticSpeech, toPcm } from "../../../../voice/test/input/speech.ts";
import type { MindReply } from "../fakes/mind.ts";
import type { TwinPeer } from "../fakes/peer.ts";
import type { Capture } from "../twin.ts";

/** werift offers no loopback host candidate, so the caller needs another interface. */
export const CAN_DIAL = Object.values(networkInterfaces()).some((addresses) =>
  addresses?.some((a) => a.family === "IPv4" && !a.internal),
);

/** A scenario runs on both engines, each call in real time. */
export const SCENARIO_MS = 120_000;

const ROOM_TONE = 60;

/** A question: a breath of room tone, 2 s of speech, and a little more room tone. */
export const QUESTION = toPcm(
  concat(noise(0.4, ROOM_TONE, 1), syntheticSpeech(2, 21), noise(0.4, ROOM_TONE, 2)),
);

/** A short sound the recognizer makes nothing of: a cough. */
export const COUGH = toPcm(concat(syntheticSpeech(0.6, 41), noise(0.4, ROOM_TONE, 3)));

export const GREETING: MindReply = {
  deltas: ["你好呀，", "欢迎来花店。", "今天想聊点什么？"],
  deltaMs: 40,
};

/** A reply long enough to talk over: about 3 s of Fish audio. */
export const LONG_REPLY: MindReply = {
  deltas: ["嗯，", "今天花店来了好多新的花，", "有玫瑰也有向日葵。", "你想先看哪一种呢？"],
  deltaMs: 40,
};

export const SHORT_REPLY: MindReply = { deltas: ["好呀，", "那我们慢慢聊。"], deltaMs: 40 };

/** client-js's client-ready, as 1.16.0 sends it. */
export function clientReady(peer: TwinPeer): void {
  peer.rtvi("client-ready", {
    version: "2.3.0",
    about: { library: "@pipecat-ai/client-js", library_version: "1.16.0" },
  });
}

/** Connects as a client does and lets her greeting play out. */
export async function greeted(peer: TwinPeer): Promise<void> {
  clientReady(peer);
  await peer.waitFor("bot-ready");
  await finished(peer, 1);
}

/** Waits until her `n`th reply has been spoken and the call has gone quiet. */
export async function finished(peer: TwinPeer, n: number): Promise<void> {
  await peer.waitFor("bot-started-speaking", n);
  await peer.waitFor("bot-stopped-speaking", n);
  await peer.quiet(800);
}

/** client-js's sendText. */
export function sendText(
  peer: TwinPeer,
  content: string,
  options: { readonly runImmediately?: boolean; readonly audioResponse?: boolean } = {},
): string {
  return peer.rtvi("send-text", {
    content,
    options: {
      run_immediately: options.runImmediately ?? true,
      audio_response: options.audioResponse ?? true,
    },
  });
}

/**
 * The twin scenarios hold two real-time calls each, minutes in all, so they run on request:
 * `EIDOLON_TWIN=1 bun test --no-env-file packages/runtime/test/parity`.
 */
export const TWIN = CAN_DIAL && process.env.EIDOLON_TWIN === "1";

/**
 * Whether the caller cut her off while her audio played: a bot-stopped-speaking that came after
 * bot-interrupted, inside one of her replies.
 */
export function cutOff(capture: Capture): boolean {
  let speaking = false;
  let interrupted = false;
  for (const { message } of capture.received) {
    if (message.type === "bot-started-speaking") {
      speaking = true;
      interrupted = false;
    } else if (message.type === "bot-interrupted" && speaking) {
      interrupted = true;
    } else if (message.type === "bot-stopped-speaking") {
      if (interrupted) return true;
      speaking = false;
    }
  }
  return false;
}
