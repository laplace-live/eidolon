// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/openai/src/realtime/llm.ts@ce8f8bc
// The null-usage guard and the failed response's fallback text are 34d7530's, ported by hand.
//
// OpenAI's Realtime API, with its server VAD on. It takes and speaks 24 kHz PCM.
// https://platform.openai.com/docs/guides/realtime-websocket
import { isPlainObject } from "@eidolon/config";
import { type Dialect, functionTools, num, obj, realtimeBase, str } from "./wire.ts";

const BENIGN_CODES: ReadonlySet<unknown> = new Set([
  "response_cancel_not_active",
  "conversation_already_has_active_response",
]);

export const OPENAI: Dialect = {
  label: "OpenAIRealtimeLLMService",
  name: "OpenAI Realtime",
  inputRate: 24000,
  url: (selection) => `${realtimeBase(selection)}?model=${selection.model}`,
  configureOn: "session.created",
  session(options, selection) {
    const { transcription } = options;
    const input =
      transcription === null
        ? {}
        : {
            input: {
              transcription: {
                model: transcription.model,
                ...(transcription.language === null ? {} : { language: transcription.language }),
              },
            },
          };
    return {
      type: "realtime",
      model: selection.model,
      instructions: options.instructions,
      audio: { ...input, output: { voice: options.voice } },
      tools: functionTools(options.tools),
    };
  },
  response: { output_modalities: ["audio"] },
  systemRole: "system",
  audioBeforeReady: true,
  trimTranscripts: false,
  tokens(event) {
    const usage = obj(event.response).usage;
    if (!isPlainObject(usage)) return null;
    return {
      input: num(usage.input_tokens) ?? 0,
      cached: num(obj(usage.input_token_details).cached_tokens) ?? 0,
      output: num(usage.output_tokens) ?? 0,
    };
  },
  failure: (response) => str(obj(obj(response.status_details).error).message) || "Response failed",
  benign: (error) => BENIGN_CODES.has(error.code),
  fatal(event) {
    // The ErrorEvent model's JSON, as pipedog's message had it.
    const error = obj(event.error);
    const dump = {
      event_id: event.event_id ?? null,
      type: "error",
      error: {
        type: error.type ?? null,
        code: error.code === undefined ? "" : error.code,
        message: error.message ?? null,
        param: error.param ?? null,
        event_id: error.event_id ?? null,
      },
    };
    return `Error: ${JSON.stringify(dump)}`;
  },
  connectFailed: (error) => `Error connecting: ${error}`,
};
