// Copyright (c) 2024-2026, Daily
// Copyright (c) 2026, pipedog contributors
// SPDX-License-Identifier: BSD-2-Clause
//
// Ported from pipedog packages/core/src/processors/frameworks/rtvi/{observer,processor}.ts@ce8f8bc
//
// What a call tells the client: one method per RTVI message, in the shapes pipedog's RTVIObserver
// and RTVIProcessor send with their default settings, and each spoken segment's bot-output state.
import type { CallDeps, Tag } from "../types.ts";
import { PROTOCOL_VERSION, type RtviMessage, rtviMessage } from "./codec.ts";

// client-js only exposes these, so `metrics` stays true although no metrics message is sent.
const CAPABILITIES = {
  audio_in: true,
  audio_out: true,
  video_in: false,
  screen_in: false,
  video_out: false,
  metrics: true,
} as const;

interface Segment {
  readonly id: number;
  readonly text: string;
  started: boolean;
}

/** pipedog's `timeNowIso8601`. */
function isoNow(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

function keyOf(tag: Tag): string {
  return `${tag.reply}\n${tag.persona}\n${tag.seg}`;
}

export class RtviEmitter {
  readonly #send: (message: RtviMessage) => void;
  readonly #about: CallDeps["about"];
  readonly #segments = new Map<string, Segment>();
  #nextSegmentId = 1;

  constructor(send: (message: RtviMessage) => void, about: CallDeps["about"]) {
    this.#send = send;
    this.#about = about;
  }

  botReady(id: string): void {
    const data = {
      version: PROTOCOL_VERSION,
      about: { ...this.#about },
      capabilities: CAPABILITIES,
    };
    this.#send(rtviMessage("bot-ready", data, id));
  }

  errorResponse(id: string, error: string): void {
    this.#send(rtviMessage("error-response", { error }, id));
  }

  /** pipedog sends no fatal errors: a call that can't go on ends after this instead. */
  error(error: string): void {
    this.#send(rtviMessage("error", { error, fatal: false }));
  }

  userStartedSpeaking(): void {
    this.#send(rtviMessage("user-started-speaking"));
  }

  userStoppedSpeaking(): void {
    this.#send(rtviMessage("user-stopped-speaking"));
  }

  /** Also forgets the unfinished segments: the cut reply's cursor events may still be queued. */
  botInterrupted(): void {
    this.#segments.clear();
    this.#send(rtviMessage("bot-interrupted"));
  }

  /** `user-input`, then the deprecated `user-transcription` some clients still read. */
  userTranscription(text: string, final: boolean): void {
    const timestamp = isoNow();
    const input = { text, input_type: "transcription", timestamp, final, user_id: "" };
    this.#send(rtviMessage("user-input", input));
    this.#send(rtviMessage("user-transcription", { text, user_id: "", timestamp, final }));
  }

  /** What `send-text` carried, echoing its id. */
  userTyped(text: string, msgId: string): void {
    const input = { text, input_type: "chat", timestamp: isoNow(), final: true, msg_id: msgId };
    this.#send(rtviMessage("user-input", input));
  }

  userLlmText(text: string): void {
    this.#send(rtviMessage("user-llm-text", { text }));
  }

  botLlmStarted(): void {
    this.#send(rtviMessage("bot-llm-started"));
  }

  botLlmText(text: string): void {
    this.#send(rtviMessage("bot-llm-text", { text }));
  }

  botLlmStopped(): void {
    this.#send(rtviMessage("bot-llm-stopped"));
  }

  botTtsStarted(): void {
    this.#send(rtviMessage("bot-tts-started"));
  }

  botTtsStopped(): void {
    this.#send(rtviMessage("bot-tts-stopped"));
  }

  botStartedSpeaking(): void {
    this.#send(rtviMessage("bot-started-speaking"));
  }

  botStoppedSpeaking(): void {
    this.#send(rtviMessage("bot-stopped-speaking"));
  }

  serverMessage(data: Readonly<Record<string, unknown>>): void {
    this.#send(rtviMessage("server-message", data));
  }

  // The tool messages carry no name, arguments or result: pipedog's default report level.
  toolStarted(): void {
    this.#send(rtviMessage("llm-function-call-started", {}));
  }

  toolInProgress(toolCallId: string): void {
    this.#send(rtviMessage("llm-function-call-in-progress", { tool_call_id: toolCallId }));
  }

  toolStopped(toolCallId: string, cancelled: boolean): void {
    this.#send(rtviMessage("llm-function-call-stopped", { tool_call_id: toolCallId, cancelled }));
  }

  /** Sends a reply's segment as `bot-transcription`; its `bot-output` follows the play cursor. */
  segment(tag: Tag, text: string): void {
    this.#segments.set(keyOf(tag), { id: this.#nextSegmentId++, text, started: false });
    this.#send(rtviMessage("bot-transcription", { text }));
  }

  /**
   * A segment of a reply without audio: `bot-transcription`, then the one `bot-output` pipedog's
   * observer sends for skipTts text.
   */
  unspokenSegment(text: string): void {
    this.#send(rtviMessage("bot-transcription", { text }));
    const segment = { id: this.#nextSegmentId++, text };
    this.#botOutput(segment, { spoken: false, status: "new", accumulated: null });
  }

  /** The cursor reached the segment: its "new". */
  segmentStarted(tag: Tag): void {
    const segment = this.#segments.get(keyOf(tag));
    if (segment === undefined || segment.started) return;
    segment.started = true;
    this.#botOutput(segment, { spoken: false, status: "new", accumulated: "" });
  }

  /**
   * Its played words reach `spokenTo`, a UTF-16 offset into the segment's text: "in-progress", or
   * "completed" once nothing is left.
   */
  segmentProgress(tag: Tag, spokenTo: number): void {
    const segment = this.#startedSegment(tag);
    if (segment === undefined) return;
    const accumulated = segment.text.slice(0, spokenTo);
    const done = accumulated.length === segment.text.length;
    this.#botOutput(segment, { status: done ? "completed" : "in-progress", accumulated });
    if (done) this.#complete(tag, segment);
  }

  /** The cursor passed its end: "completed", unless its words already completed it. */
  segmentEnded(tag: Tag): void {
    const segment = this.#startedSegment(tag);
    if (segment === undefined) return;
    this.#botOutput(segment, { spoken: true, status: "completed", accumulated: segment.text });
    this.#complete(tag, segment);
  }

  #startedSegment(tag: Tag): Segment | undefined {
    const segment = this.#segments.get(keyOf(tag));
    return segment?.started ? segment : undefined;
  }

  #complete(tag: Tag, segment: Segment): void {
    this.#segments.delete(keyOf(tag));
    this.#send(rtviMessage("bot-tts-text", { text: segment.text }));
  }

  // `spoken` is absent from progress, as pipedog's word-timestamp path leaves it. A segment she
  // won't speak has `accumulated` null, and no progress.
  #botOutput(
    segment: Pick<Segment, "id" | "text">,
    o: { readonly spoken?: boolean; readonly status: string; readonly accumulated: string | null },
  ): void {
    const { text } = segment;
    const { accumulated } = o;
    this.#send(
      rtviMessage("bot-output", {
        text,
        text_type: "sentence",
        aggregated_by: "sentence",
        segment_id: segment.id,
        ...(o.spoken === undefined ? {} : { spoken: o.spoken }),
        will_be_spoken: accumulated !== null,
        spoken_status: o.status,
        ...(accumulated === null
          ? {}
          : {
              spoken_progress: {
                accumulated_text: accumulated,
                remaining_text: text.slice(accumulated.length),
              },
            }),
      }),
    );
  }
}
