// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/xai/src/realtime/llm.ts@ce8f8bc
//
// xAI's Grok Voice Agent API, with its server VAD on. It takes 16 kHz PCM and speaks 24 kHz.
// https://docs.x.ai/docs/guides/voice/agent
import { isPlainObject, pyJsonDumps, pyTruthy } from "@eidolon/config";
import { type Dialect, functionTools, num, obj, realtimeBase, str } from "./wire.ts";

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

const BENIGN_CODES: ReadonlySet<unknown> = new Set([
  "response_cancel_not_active",
  "conversation_already_has_active_response",
]);

// Grok's codes for a cancel with nothing to cancel, or a second response, differ from OpenAI's:
// only the message says so.
const BENIGN_TEXT = ["no active response", "already has an active response", "truncat"];

export const XAI: Dialect = {
  label: "GrokRealtimeLLMService",
  name: "Grok Realtime",
  inputRate: INPUT_RATE,
  url: (selection) => `${realtimeBase(selection)}?model=${encodeURIComponent(selection.model)}`,
  configureOn: "conversation.created",
  session: (options) => ({
    instructions: options.instructions,
    voice: options.voice,
    turn_detection: { type: "server_vad" },
    audio: {
      input: { format: { type: "audio/pcm", rate: INPUT_RATE } },
      output: { format: { type: "audio/pcm", rate: OUTPUT_RATE } },
    },
    tools: functionTools(options.tools),
  }),
  response: { modalities: ["text", "audio"] },
  systemRole: "user",
  audioBeforeReady: false,
  trimTranscripts: true,
  tokens(event) {
    const usage = event.usage ?? obj(event.response).usage;
    if (!isPlainObject(usage) || !num(usage.total_tokens)) return null;
    return {
      input: num(usage.input_tokens) ?? 0,
      cached: 0,
      output: num(usage.output_tokens) ?? 0,
    };
  },
  failure(response) {
    const details = response.status_details;
    if (!pyTruthy(details)) return "Response failed";
    return typeof details === "string" ? details : pyJsonDumps(details);
  },
  benign(error) {
    if (BENIGN_CODES.has(error.code)) return true;
    const message = (str(error.message) ?? "").toLowerCase();
    return BENIGN_TEXT.some((text) => message.includes(text));
  },
  fatal: (event) => `Grok Realtime Error: ${str(obj(event.error).message) ?? ""}`,
  connectFailed: (error) => `Error connecting to Grok: ${error}`,
};
